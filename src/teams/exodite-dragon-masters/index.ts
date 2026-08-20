/**
 * EXODITE DRAGON MASTERS — Aeldari maiden-world cavalry.
 * https://wahapedia.ru/kill-team3/kill-teams/exodite-dragon-masters/
 *
 * Rule text is read from `data/teams/exodite-dragon-masters.json` and never retyped; every
 * hook carries a short verbatim quote of the printed rule in its `RuleBinding`.
 *
 * Four datacards, three faction rules, eight datacard abilities, one printed unique action —
 * and **fifteen "Upgrade" sub-rules** which the scrape appends to the end of the Mercurial
 * Speed faction rule with no ids of their own. They are sliced out of that one string at module
 * load (`UPGRADE_TEXT`), the Kasrkin SKILL AT ARMS / Legionary Marks of Chaos / Warpcoven BOONS
 * exception to "never retype printed rule text". Each of the three MOUNTED operatives takes
 * "up to two different" of its own five, through the pure setter `setUpgrades` (docs/DECISIONS.md
 * D-017 — Select Operatives still has no decision channel, so nothing applies until it is called).
 *
 * Three shapes drive the module:
 *
 *  - **The Sprint.** Drakesteed Agility bans Charge/Dash/Fall Back/Reposition for MOUNTED
 *    operatives and replaces them with SPRINT (0AP) and TURN (1AP). `validateMove` cannot
 *    express "directly forwards or backwards", "one pivot of up to 45°", "it can move through
 *    operatives" or "it treats terrain parts less than 2\" tall as Accessible terrain", and
 *    `onMoveRules` — the hook that carries three of those flags — is declared but NEVER
 *    EMITTED, so registering against it would be the silent no-op CLAUDE.md rule 5 forbids.
 *    SPRINT therefore owns its own path planner (`planSprint`), exactly as the Murderwing BOOST
 *    owns `planBoost` (D-021). The printed "for the purposes of your opponent's rules, mission
 *    rules and killzone rules, this action is treated as the Reposition action, or the Charge
 *    action if it ends within control range of an enemy operative" is honoured by pushing that
 *    label into `actionsThisActivation` from inside `perform`, which is the only channel by
 *    which one action can be seen as another; the action's OWN restriction key stays `SPRINT`,
 *    so MOONSONG CULL's second Sprint needs its own sibling ActionDef and an ordinary second
 *    Sprint is still refused.
 *  - **SPEED.** Mercurial Speed gives every operative one of three levels. The three levels are
 *    treated as DISTINCT, not as thresholds: SINUOUS FLUX prints "SPEED 4+ **or SPEED 7+**"
 *    where WIND-SWIFT PRECISION, DRACONIC FURY and SPEARTIP OF THE CLAN name one level each, so
 *    "has SPEED 4+" means exactly that level. `speedOf` is the one reader.
 *  - **Two activations per turning point.** Draconic Cavalry Tactics re-readies a MOUNTED
 *    operative at `onActivationEnd` (the hook fires after `EndActivation` has set
 *    `expended`/`ready`, so it can undo them) and the module owns the "no more than 3AP per
 *    activation, or more than its APL stat per turning point" budget through `canPerformAction`.
 *
 * Data notes (`exodite-dragon-masters.json › notes`):
 *  - "no datacard in this team carries the LEADER keyword" — `selection.leader.count` is 0 and
 *    the shared validator's leader check passes trivially (the Warpcoven shape). Nothing here
 *    assumes a LEADER; the kill team is a FIXED five: CLANBLADE, LEYSTALKER, STONESINGER and
 *    two DRAKOLITHEs.
 */
import { actionCost, getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { addAutoNormal, allocateSavesOptimally, countCrits, countNormals, hasRule } from '../../core/dice.ts';
import { baseGap, baseRadius, dist, rotate, segmentCrossesPoly, sub } from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import type { ActionParams } from '../../core/intents.ts';
import { advanceFight, startFight } from '../../core/sequences/fight.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  card as cardOfOp,
  enemiesInControlRange,
  inControlRange,
  inflictDamage,
  isInjured,
  log,
  markerController,
  modelHeight,
  recordRoll,
} from '../../core/state.ts';
import {
  baseBlockedByTerrain,
  baseDistanceToPart,
  baseTouchesHazardous,
  hasType,
  surfaceAt,
  type IndexedPart,
  type TerrainIndex,
} from '../../core/terrain.ts';
import type { Datacard, GameState, OperativeState, PlayerId, Vec2, Weapon } from '../../core/types.ts';
import { interveningParts, isVisible } from '../../core/visibility.ts';
import { parseWeaponRules } from '../../core/weaponRules.ts';
import { teamData, type TeamData } from '../data.ts';
import {
  bucket,
  chosenOperative,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  hasEquipment,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerSequence,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('exodite-dragon-masters');

const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;

export const KW = 'EXODITE DRAGON MASTER';
export const MOUNTED = 'MOUNTED';
const EPS = 1e-6;

export const CARD = {
  clanblade: 'exodite-dragon-masters.dragon-master-clanblade',
  leystalker: 'exodite-dragon-masters.dragon-master-leystalker',
  stonesinger: 'exodite-dragon-masters.dragon-master-stonesinger',
  drakolithe: 'exodite-dragon-masters.drakolithe',
} as const;

export const RULE = {
  agility: 'exodite-dragon-masters.rule.drakesteed-agility',
  cavalry: 'exodite-dragon-masters.rule.draconic-cavalry-tactics',
  speed: 'exodite-dragon-masters.rule.mercurial-speed',
} as const;

export const SP = {
  windSwift: 'exodite-dragon-masters.sp.wind-swift-precision',
  draconicFury: 'exodite-dragon-masters.sp.draconic-fury',
  sinuousFlux: 'exodite-dragon-masters.sp.sinuous-flux',
  rideThemDown: 'exodite-dragon-masters.sp.ride-them-down',
} as const;

export const FP = {
  survivalistSpirit: 'exodite-dragon-masters.fp.survivalist-spirit',
  leap: 'exodite-dragon-masters.fp.leap',
  feralHunger: 'exodite-dragon-masters.fp.feral-hunger',
  ridingMastery: 'exodite-dragon-masters.fp.riding-mastery',
} as const;

export const EQ = {
  dragonscaleMesh: 'exodite-dragon-masters.eq.dragonscale-mesh',
  clanTalismans: 'exodite-dragon-masters.eq.clan-talismans',
  lileathan: 'exodite-dragon-masters.eq.lileathan-crystal-matrices',
  spiritStones: 'exodite-dragon-masters.eq.spirit-stones',
} as const;

export const ABILITY = {
  scaleshield: 'exodite-dragon-masters.dragon-master-clanblade.scaleshield',
  clanbladeUpgrades: 'exodite-dragon-masters.dragon-master-clanblade.clanblade-upgrades',
  aimed: 'exodite-dragon-masters.dragon-master-leystalker.aimed',
  implacable: 'exodite-dragon-masters.dragon-master-leystalker.implacable-darkscale',
  leystalkerUpgrades: 'exodite-dragon-masters.dragon-master-leystalker.leystalker-upgrades',
  stonesingerUpgrades: 'exodite-dragon-masters.dragon-master-stonesinger.stonesinger-upgrades',
  preternatural: 'exodite-dragon-masters.drakolithe.preternatural-evasion',
  beast: 'exodite-dragon-masters.drakolithe.beast',
} as const;

export const SONG_OF_RENEWAL = 'exodite-dragon-masters.dragon-master-stonesinger.act.song-of-renewal';

/** Action ids this module registers on top of the printed unique action. */
export const SPRINT = 'SPRINT';
export const TURN = 'TURN';
export const SPRINT_MOONSONG = 'SPRINT (Moonsong Cull)';
export const SPRINT_NOMAD = 'SPRINT (Nomad Executioner)';
export const SPRINT_RIDING = 'SPRINT (Riding Mastery)';
export const FIGHT_REACH = 'Fight (Draconic Cavalry Tactics)';
export const GUARD_NEXUS = 'Guard (Nexus Sentinel)';
export const ACT_WAILS = 'WAILS OF THE WORLD';
export const ACT_CLEANSING = 'CLEANSING OF THE PALE MOON';
export const ACT_WINDS_GRACE = 'WIND’S GRACE';

/** Effect / scratch keys, all namespaced. */
const SPEED_KEY = 'edm.speed';
const UPGRADE_KEY = 'edm.upgrades';
const SPRINT_KEY = 'edm.sprint';
const ACTIVATIONS_KEY = 'edm.activations';
const AP_TP_KEY = 'edm.apThisTP';
const EVASION_KEY = 'edm.evasion';
const WINDS_GRACE = 'edm.windsGrace';
const SURVIVALIST = 'edm.survivalistSpirit';
const LEAP_ARMED = 'edm.leapArmed';
const NOMAD_WINDOW = 'edm.nomadWindow';
const RIDING_WINDOW = 'edm.ridingWindow';
const MOONSONG_KILL = 'edm.moonsongKill';
const FATED_SHOT = 'edm.fatedShot';
const LILEATHAN = 'edm.lileathan';
const SOW_THE_SEEDS = 'edm.sowTheSeeds';
const FOCUSED_SNAPSHOT = 'edm.focusedReflection';
const SPEARTIP_USED = 'edm.speartipUsed';
const AIMED_USED = 'edm.aimedUsed';
const NEXUS_GUARD = 'edm.nexusGuard';
const WAILS_SLOW = 'edm.wailsSlow';

// ---------------------------------------------------------------------------
// The three Upgrade menus, sliced out of the Mercurial Speed faction rule
// ---------------------------------------------------------------------------

export const CLANBLADE_UPGRADES = [
  'MOONSONG CULL',
  'SPECTRAL NIMBUS',
  'FOCUSED REFLECTION',
  'SPEARTIP OF THE CLAN',
  'BLADED STANCE',
] as const;
export const LEYSTALKER_UPGRADES = [
  'NOMAD EXECUTIONER',
  'ELUSIVE PHANTASM',
  'FATED SHOT',
  'NEXUS SENTINEL',
  'GLOAMING MANTLE',
] as const;
export const STONESINGER_UPGRADES = [
  'WAILS OF THE WORLD',
  'CLEANSING OF THE PALE MOON',
  'SOW THE SEEDS',
  ACT_WINDS_GRACE,
  'EARTHEN WRATH',
] as const;

export type Upgrade =
  | (typeof CLANBLADE_UPGRADES)[number]
  | (typeof LEYSTALKER_UPGRADES)[number]
  | (typeof STONESINGER_UPGRADES)[number];

export const UPGRADES_BY_CARD: Record<string, readonly Upgrade[]> = {
  [CARD.clanblade]: CLANBLADE_UPGRADES,
  [CARD.leystalker]: LEYSTALKER_UPGRADES,
  [CARD.stonesinger]: STONESINGER_UPGRADES,
};

const ALL_UPGRADES: readonly Upgrade[] = [
  ...CLANBLADE_UPGRADES,
  ...LEYSTALKER_UPGRADES,
  ...STONESINGER_UPGRADES,
];

/** The section headings the scrape leaves between the three menus. */
const UPGRADE_SECTIONS = ['Clanblade Upgrade', 'Leystalker Upgrade', 'Stonesinger Upgrade'];

/**
 * Each upgrade is `<HEADING>` then one line of flavour prose, then the rule (which may run to
 * several paragraphs, and for three of them starts with the run-together `NAME1AP` action
 * header). The one flavour LINE is dropped — a paragraph split would not do, because eleven of
 * the fifteen print the flavour and the rule as consecutive lines of one paragraph.
 */
export const UPGRADE_TEXT: Record<Upgrade, string> = sliceUpgradeTexts();

function sliceUpgradeTexts(): Record<Upgrade, string> {
  const lines = text(RULE.speed).split('\n');
  const marks = ALL_UPGRADES.map((name) => ({ name, at: lines.indexOf(name) }));
  const out = {} as Record<Upgrade, string>;
  marks.forEach((mark, i) => {
    if (mark.at < 0)
      throw new Error(`Upgrade '${mark.name}' is not printed in data/teams/${DATA.id}.json`);
    let to = marks[i + 1]?.at ?? lines.length;
    // The next menu's heading ("Leystalker Upgrade") sits on the line before its first entry.
    if (to > mark.at && UPGRADE_SECTIONS.includes((lines[to - 1] ?? '').trim())) to -= 1;
    const body = lines.slice(mark.at + 1, to);
    const flavour = body.findIndex((l) => l.trim().length > 0);
    out[mark.name] = body
      .slice(flavour + 1)
      .join('\n')
      .trim();
  });
  return out;
}

/** "WAILS OF THE WORLD1AP" — the three action upgrades print their AP glued to the heading. */
function upgradeActionAp(upgrade: Upgrade): number {
  const m = new RegExp(`^${upgrade.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d)AP$`, 'm').exec(UPGRADE_TEXT[upgrade]);
  if (!m) throw new Error(`Upgrade '${upgrade}' does not print an AP cost`);
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// EARTHEN WRATH — the granted weapon, parsed out of the printed table
// ---------------------------------------------------------------------------

/**
 * "This operative has the following ranged weapon: … Earthen Wrath / 4 / 3+ / 4/3 / WR /
 * Devastating 2, Saturate, Earthen Wrath*". The scrape leaves the table as one column of
 * lines, so the stats are read from it rather than being copied into this file.
 */
export const EARTHEN_WRATH_WEAPON: Weapon = parseEarthenWrath();

function parseEarthenWrath(): Weapon {
  const lines = UPGRADE_TEXT['EARTHEN WRATH'].split('\n').map((s) => s.trim());
  const dmgHeader = lines.indexOf('DMG');
  const cells = lines.slice(dmgHeader + 1).filter(Boolean);
  const [name, atk, hit, dmg, wrHeader, rules] = cells;
  if (!name || !atk || !hit || !dmg || wrHeader !== 'WR' || !rules)
    throw new Error('EARTHEN WRATH weapon table is not in the printed shape');
  const [dmgN, dmgC] = dmg.split('/').map((n) => Number(n));
  return {
    name,
    profiles: [
      {
        type: 'ranged',
        atk: Number(atk),
        hit: Number(hit.replace('+', '')),
        dmgN: dmgN ?? 0,
        dmgC: dmgC ?? 0,
        rules: parseWeaponRules(rules),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Upgrades: the pure setter (D-017)
// ---------------------------------------------------------------------------

function upgradeStore(state: GameState): Record<string, Upgrade[]> {
  return bucket(state, UPGRADE_KEY) as Record<string, Upgrade[]>;
}

export function upgradesOf(state: GameState, op: OperativeState): Upgrade[] {
  return upgradeStore(state)[op.id] ?? [];
}

export function hasUpgrade(state: GameState, op: OperativeState, upgrade: Upgrade): boolean {
  return upgradesOf(state, op).includes(upgrade);
}

/**
 * "When this operative is selected for the battle, select up to two different <X> Upgrade
 * rules to be added to its datacard for the battle."
 *
 * Select Operatives has no decision channel (docs/TEAM-STATUS.md › Known engine gaps), so the
 * choice is made through this pure setter — the UI, the tests and a roster spec all call it.
 * Nothing applies until it is called.
 */
export function setUpgrades(
  state: GameState,
  operativeId: string,
  upgrades: Upgrade[],
): { ok: boolean; reason?: string } {
  const op = state.operatives[operativeId];
  if (!op) return { ok: false, reason: 'no such operative' };
  const menu = UPGRADES_BY_CARD[op.datacardId];
  if (!menu) return { ok: false, reason: 'that operative has no Upgrade rules' };
  if (upgrades.length > 2) return { ok: false, reason: 'select up to two different Upgrade rules' };
  if (new Set(upgrades).size !== upgrades.length)
    return { ok: false, reason: 'select up to two DIFFERENT Upgrade rules' };
  for (const u of upgrades)
    if (!menu.includes(u)) return { ok: false, reason: `${u} is not one of this operative's Upgrade rules` };
  upgradeStore(state)[operativeId] = [...upgrades];
  log(state, { kind: 'system', player: op.player, text: `${op.letter}: ${upgrades.join(' + ') || 'no upgrades'}` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Mercurial Speed
// ---------------------------------------------------------------------------

/** The three printed levels. They are DISTINCT, not thresholds — see the module header. */
export type Speed = 'low' | 'mid' | 'high';
export const SPEED_LABEL: Record<Speed, string> = { low: 'SPEED 3-', mid: 'SPEED 4+', high: 'SPEED 7+' };

function speedStore(state: GameState): Record<string, Speed> {
  return bucket(state, SPEED_KEY) as Record<string, Speed>;
}

/** "…it starts the battle with SPEED 3-." */
export function baseSpeedOf(state: GameState, op: OperativeState): Speed {
  return speedStore(state)[op.id] ?? 'low';
}

export function setSpeed(state: GameState, op: OperativeState, speed: Speed): void {
  if (baseSpeedOf(state, op) === speed) return;
  speedStore(state)[op.id] = speed;
  log(state, { kind: 'system', player: op.player, text: `${op.letter} has ${SPEED_LABEL[speed]}` });
}

const oneHigher = (s: Speed): Speed => (s === 'low' ? 'mid' : 'high');

/**
 * The SPEED an operative has right now, including WIND'S GRACE ("that selected operative's
 * SPEED is one higher") and NOMAD EXECUTIONER ("as the Shoot action occurs before the Sprint
 * action ends, for that Shoot action, this operative's SPEED is whatever it had before
 * beginning the Sprint action").
 */
export function speedOf(state: GameState, op: OperativeState): Speed {
  settleEvasion(state, op); // DRAKOLITHE › Preternatural Evasion, settled lazily
  const window = effectOn(state, op.id, NOMAD_WINDOW);
  const seq = state.sequence;
  if (window && seq?.kind === 'shoot' && seq.attackerId === op.id) {
    return (window.data?.['speed'] as Speed | undefined) ?? 'low';
  }
  const base = baseSpeedOf(state, op);
  return effectOn(state, op.id, WINDS_GRACE) ? oneHigher(base) : base;
}

// ---------------------------------------------------------------------------
// Small shared predicates
// ---------------------------------------------------------------------------

const keywordsOf = (ctx: GameContext, op: OperativeState): string[] =>
  ctx.datacards.get(op.datacardId)?.keywords ?? [];

const isDragonMaster = (ctx: GameContext, op: OperativeState): boolean => keywordsOf(ctx, op).includes(KW);
const isMounted = (ctx: GameContext, op: OperativeState): boolean =>
  isDragonMaster(ctx, op) && keywordsOf(ctx, op).includes(MOUNTED);

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;
const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

const counteracting = (state: GameState, op: OperativeState): boolean =>
  state.opState['counteract']?.['operativeId'] === op.id;

/** Heading unit vector from the operative's facing (`baseSemiAxes`: a is along facing). */
const heading = (rotDeg: number): Vec2 => rotate({ x: 1, y: 0 }, rotDeg);
const angleOf = (v: Vec2): number => (Math.atan2(v.y, v.x) * 180) / Math.PI;
/** Smallest absolute angle between two directions, in degrees. */
function angleBetween(a: Vec2, b: Vec2): number {
  const d = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
  return Math.abs((d * 180) / Math.PI);
}

// ---------------------------------------------------------------------------
// The Sprint movement ledger
// ---------------------------------------------------------------------------

interface SprintLedger {
  /** Inches moved forwards / backwards during THIS activation. */
  fwd: number;
  back: number;
  /** Inches moved this turning point (forwards and backwards alike). */
  tp: number;
}

function ledgerOf(state: GameState, op: OperativeState): SprintLedger {
  const store = bucket(state, SPRINT_KEY) as Record<string, SprintLedger>;
  const found = store[op.id];
  if (found) return found;
  const fresh: SprintLedger = { fwd: 0, back: 0, tp: 0 };
  store[op.id] = fresh;
  return fresh;
}

export function sprintAllowance(state: GameState, op: OperativeState): { forwards: number; backwards: number } {
  const led = ledgerOf(state, op);
  const tpLeft = Math.max(0, 12 - led.tp);
  // Aimed: "…and it cannot move more than 3" during an activation in which it used this weapon."
  const aimed = effectOn(state, op.id, AIMED_USED) ? Math.max(0, 3 - led.fwd - led.back) : Infinity;
  return {
    forwards: Math.max(0, Math.min(9 - led.fwd, tpLeft, aimed)),
    backwards: Math.max(0, Math.min(3 - led.back, tpLeft, aimed)),
  };
}

// ---------------------------------------------------------------------------
// Sprint geometry
// ---------------------------------------------------------------------------

/**
 * "The active operative cannot climb … it treats terrain parts less than 2" tall as
 * Accessible terrain" — a standable surface lower than 2" is moved THROUGH, not onto, so it
 * never counts as an elevation for a Sprint.
 */
function sprintSurface(index: TerrainIndex, p: Vec2): number {
  const z = surfaceAt(index, p);
  return z >= 2 - EPS ? z : 0;
}

/** Parts a Sprint treats as Accessible: printed Accessible terrain, plus anything under 2" tall. */
const sprintAccessible = (part: IndexedPart): boolean => hasType(part, 'Accessible') || part.z1 < 2 - EPS;

interface SprintLeg {
  to: Vec2;
  z: number;
  charged: number;
  backward: boolean;
}

interface SprintPlan {
  ok: boolean;
  reason?: string;
  legs?: SprintLeg[];
  endRot?: number;
  fwd?: number;
  back?: number;
  /** Equipment terrain features the move passed through. */
  featureIds?: string[];
}

interface SprintOpts {
  /** ELUSIVE PHANTASM / RIDE THEM DOWN style caps on this single action. */
  cap?: number;
  /** MOONSONG CULL: "it cannot pivot during that free action". */
  noPivot?: boolean;
}

/** Can this operative legally stand here? (Set-up legality, not a move.) */
function canPlaceAt(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  pos: Vec2,
  z: number,
  rot: number,
): { ok: boolean; reason?: string } {
  const index = terrain(ctx, state);
  const c = cardOfOp(ctx, op);
  if (baseBlockedByTerrain(index, pos, c.base, rot, z, modelHeight(c)))
    return { ok: false, reason: 'it cannot be placed inside terrain' };
  if (baseTouchesHazardous(index, pos, c.base, rot))
    return { ok: false, reason: 'a base cannot touch a hazardous area' };
  // "…bases cannot be over the edge of the killzone."
  const { w, h } = state.map.board;
  const r = baseRadius(c.base);
  if (pos.x - r < -EPS || pos.y - r < -EPS || pos.x + r > w + EPS || pos.y + r > h + EPS)
    return { ok: false, reason: 'bases cannot be over the edge of the killzone' };
  for (const other of aliveOperatives(state)) {
    if (other.id === op.id) continue;
    if (Math.abs(other.z - z) > 1) continue;
    if (baseGap(pos, c.base, rot, other.pos, cardOfOp(ctx, other).base, other.rot) < -1e-4)
      return { ok: false, reason: 'a base cannot be placed on another' };
  }
  return { ok: true };
}

/**
 * SPRINT: "Move the active operative to a location it can be placed. This must be directly
 * forwards or backwards in one or more straight-line increments, and increments are always
 * rounded up to the nearest inch… Before or after one of the increments, you can pivot the
 * active operative up to 45°."
 *
 * Waypoints come from `params.path.points`, or a single increment to `params.targetPos`, or —
 * when neither is supplied — a deterministic, logged default of "as far directly forwards as
 * this operative can legally go" (D-016). The pivot is inferred: exactly ONE heading change of
 * up to 45° is permitted anywhere in the sequence, which is what the printed text allows.
 *
 * Pure: `check` and `perform` both run this, so whatever `check` accepts `perform` completes
 * (docs/DECISIONS.md D-026).
 */
function planSprint(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  opts: SprintOpts = {},
): SprintPlan {
  const index = terrain(ctx, state);
  const allowance = sprintAllowance(state, op);
  const maxFwd = Math.min(allowance.forwards, opts.cap ?? Infinity);
  const maxBack = Math.min(allowance.backwards, opts.cap ?? Infinity);
  if (maxFwd < 1 && maxBack < 1)
    return { ok: false, reason: 'it has no Sprint movement allowance left' };

  const points = sprintWaypoints(ctx, state, op, params, maxFwd);
  if (points.length === 0) return { ok: false, reason: 'select where to Sprint to' };

  let rot = op.rot;
  let pivoted = false;
  let cur: Vec2 = { ...op.pos };
  let curZ = op.z;
  let fwd = 0;
  let back = 0;
  const legs: SprintLeg[] = [];
  const featureIds = new Set<string>();

  for (const next of points) {
    const d = sub(next, cur);
    const raw = dist(cur, next);
    if (raw < EPS) continue;
    const h = heading(rot);
    const off = angleBetween(d, h);
    const backward = off > 90;
    const turn = backward ? 180 - off : off;
    if (turn > EPS) {
      if (opts.noPivot) return { ok: false, reason: 'it cannot pivot during that free action' };
      if (pivoted) return { ok: false, reason: 'a Sprint may pivot only once, up to 45°' };
      if (turn > 45 + 1e-4) return { ok: false, reason: 'a Sprint pivot is up to 45°' };
      pivoted = true;
      rot = backward ? angleOf(d) + 180 : angleOf(d);
    }

    // "…it cannot climb"; a surface lower than 2" is Accessible terrain, moved through.
    const z = sprintSurface(index, next);
    if (z > curZ + EPS) return { ok: false, reason: 'the Sprint action cannot climb' };

    // Wall terrain still blocks: the Sprint prints no exemption from it.
    const wall = index.walls.find(
      (w) => w.solid !== false && !(w.role === 'accessPoint' && w.state === 'open') && segmentCrossesPoly(cur, next, w.poly),
    );
    if (wall) return { ok: false, reason: 'it cannot move through Wall terrain' };

    // Accessible terrain "counts as an additional 1"" — including everything under 2" tall.
    const crossedParts = index.parts.filter((p) => segmentCrossesPoly(cur, next, p.poly));
    const charged = Math.ceil(raw - 1e-9) + (crossedParts.some(sprintAccessible) ? 1 : 0);
    // "Whenever it moves through an equipment terrain feature, remove that terrain feature."
    for (const p of crossedParts) if (isEquipmentFeature(state, p)) featureIds.add(p.featureId);

    if (backward) back += charged;
    else fwd += charged;
    legs.push({ to: { ...next }, z, charged, backward });
    cur = { ...next };
    curZ = z;
  }

  if (legs.length === 0) return { ok: false, reason: 'a Sprint must move the operative at least 1"' };
  if (fwd > maxFwd + EPS)
    return { ok: false, reason: `a ${fwd}" forward Sprint exceeds the ${maxFwd}" it has left` };
  if (back > maxBack + EPS)
    return { ok: false, reason: `a ${back}" backward Sprint exceeds the ${maxBack}" it has left` };
  if (fwd + back > Math.max(0, 12 - ledgerOf(state, op).tp) + EPS)
    return { ok: false, reason: 'it cannot move more than 12" per turning point' };

  // "…cannot finish the move on Vantage terrain higher than 2" from the killzone floor."
  if (curZ > 2 + EPS) return { ok: false, reason: 'it cannot finish on Vantage terrain higher than 2"' };
  const endRot = params.path?.endRot ?? rot;
  const place = canPlaceAt(ctx, state, op, cur, curZ, endRot);
  if (!place.ok) return { ok: false, reason: place.reason ?? 'it cannot be placed there' };

  return { ok: true, legs, endRot, fwd, back, featureIds: [...featureIds] };
}

function isEquipmentFeature(state: GameState, part: IndexedPart): boolean {
  if (state.terrainState[part.id]?.removed) return false;
  return part.feature.kind.startsWith('equipment.') || part.feature.owner !== undefined;
}

/** The waypoints a Sprint should use, with the deterministic "straight forward" default. */
function sprintWaypoints(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  maxFwd: number,
): Vec2[] {
  if (params.path?.points && params.path.points.length > 0) return params.path.points.map((p) => ({ ...p }));
  if (params.targetPos && dist(op.pos, params.targetPos) >= 1 - EPS) return [{ ...params.targetPos }];
  // D-016: no destination supplied, so take the furthest legal spot directly forwards.
  const h = heading(op.rot);
  const index = terrain(ctx, state);
  for (let step = Math.floor(maxFwd); step >= 1; step--) {
    const p = { x: op.pos.x + h.x * step, y: op.pos.y + h.y * step };
    const z = sprintSurface(index, p);
    if (z > op.z + EPS) continue;
    if (z > 2 + EPS) continue;
    if (!canPlaceAt(ctx, state, op, p, z, op.rot).ok) continue;
    return [p];
  }
  return [];
}

/** Apply a validated Sprint plan. */
function applySprint(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  plan: SprintPlan,
  opts: { label: string; keepSpeed?: boolean },
): void {
  const last = plan.legs![plan.legs!.length - 1]!;
  op.pos = { ...last.to };
  op.z = last.z;
  op.rot = plan.endRot ?? op.rot;
  op.onGuard = false;
  if (op.carryingMarkerId) {
    const m = state.markers[op.carryingMarkerId];
    if (m) {
      m.pos = { ...op.pos };
      m.z = op.z;
    }
  }
  for (const featureId of plan.featureIds ?? []) removeEquipmentFeature(ctx, state, featureId);

  const led = ledgerOf(state, op);
  led.fwd += plan.fwd ?? 0;
  led.back += plan.back ?? 0;
  led.tp += (plan.fwd ?? 0) + (plan.back ?? 0);

  log(state, {
    kind: 'action',
    player: op.player,
    text: `${op.letter} performs ${opts.label} (${(plan.fwd ?? 0) > 0 ? `${plan.fwd}" forwards` : `${plan.back}" backwards`})`,
    data: { operativeId: op.id, action: SPRINT, forwards: plan.fwd, backwards: plan.back },
  });

  if (!opts.keepSpeed) applySprintSpeed(state, op, plan);
  markTreatedAs(ctx, state, op, 'Reposition');
}

/**
 * "An EXODITE DRAGON MASTER MOUNTED operative has SPEED 3- if … it ends the Sprint action and
 * it either moved backwards or less than 4" forwards … SPEED 4+ if it ends the Sprint action
 * and moved 4" or more during that action, or SPEED 7+ instead if it moved 7" or more."
 *
 * The cumulative forward total for the activation is used, which is what MOONSONG CULL's "its
 * SPEED is measured by the distance moved during both Sprint actions combined" asks for and is
 * identical for an ordinary single Sprint.
 */
function applySprintSpeed(state: GameState, op: OperativeState, plan: SprintPlan): void {
  if ((plan.back ?? 0) > 0) {
    setSpeed(state, op, 'low');
    return;
  }
  const total = ledgerOf(state, op).fwd;
  setSpeed(state, op, total >= 7 ? 'high' : total >= 4 ? 'mid' : 'low');
}

/**
 * "For the purposes of your opponent's rules, mission rules and killzone rules, this action is
 * treated as the Reposition action, or the Charge action if the active operative ends the
 * action within control range of an enemy operative."
 *
 * `actionsThisActivation` is the only channel by which one action is seen as another, so the
 * label is pushed here; the reducer still pushes the action's own id afterwards, which keeps
 * "one Sprint per activation" working.
 */
function markTreatedAs(ctx: GameContext, state: GameState, op: OperativeState, fallback: string): void {
  const label = enemiesInControlRange(ctx, state, op).length > 0 ? 'Charge' : fallback;
  if (!op.actionsThisActivation.includes(label)) op.actionsThisActivation.push(label);
}

function removeEquipmentFeature(ctx: GameContext, state: GameState, featureId: string): void {
  const feature = terrain(ctx, state).featureById.get(featureId);
  if (!feature) return;
  for (const part of feature.parts) state.terrainState[part.id] = { ...(state.terrainState[part.id] ?? {}), removed: true };
  log(state, { kind: 'system', text: `${feature.kind} is removed from the battle (Sprint)` });
}

// ---------------------------------------------------------------------------
// RIDE THEM DOWN — resolved inside the Sprint that triggers it
// ---------------------------------------------------------------------------

/**
 * "Once during each friendly EXODITE DRAGON MASTER MOUNTED operative's activation, whenever it
 * ends its move during the Sprint action: If it moved 4" or more during that action, you can
 * inflict 1 damage on one enemy operative within its control range. If it moved 7" or more
 * during that action, or it's a CLANBLADE operative, you can inflict D3 damage on one enemy
 * operative within its control range instead."
 *
 * Free and strictly beneficial, so it is auto-used under D-022; the victim is the lowest-id
 * enemy in control range unless the intent names one (D-016).
 */
function rideThemDown(ctx: GameContext, state: GameState, op: OperativeState, plan: SprintPlan, params: ActionParams): void {
  if (!gambitUsed(state, op.player, SP.rideThemDown)) return;
  const moved = plan.fwd ?? 0;
  const clanblade = op.datacardId === CARD.clanblade;
  if (moved < 4 && !clanblade) return;
  if (!useOncePerTP(state, `edm.rideThemDown:${op.id}:${state.activationsThisTP}`)) return;
  const targets = enemiesInControlRange(ctx, state, op).sort((a, b) => (a.id < b.id ? -1 : 1));
  const victim = chosenOperative(state, params.data, targets);
  if (!victim) return;
  const big = moved >= 7 || clanblade;
  let damage = 1;
  if (big) {
    damage = ctx.rng.d3();
    recordRoll(state, 'rideThemDown', [damage], op.player, `RIDE THEM DOWN vs ${victim.letter}`);
  }
  log(state, { kind: 'ploy', player: op.player, text: `Ride Them Down: ${victim.letter} takes ${damage}` });
  inflictDamage(ctx, state, victim, damage, 'other');
}

// ---------------------------------------------------------------------------
// The SPRINT / TURN actions (Drakesteed Agility)
// ---------------------------------------------------------------------------

function sprintCheck(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  opts: SprintOpts = {},
): { ok: boolean; reason?: string } {
  if (counteracting(state, op)) return { ok: false, reason: 'an operative cannot Sprint while counteracting' };
  if (leapArmed(state, op)) {
    const leap = planLeap(ctx, state, op, params);
    return leap.ok ? { ok: true } : { ok: false, reason: leap.reason };
  }
  const plan = planSprint(ctx, state, op, params, opts);
  return plan.ok ? { ok: true } : { ok: false, reason: plan.reason ?? 'that Sprint is not possible' };
}

function sprintPerform(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
  opts: SprintOpts & { label: string; keepSpeed?: boolean },
): { ok: boolean; reason?: string } {
  if (leapArmed(state, op)) return performLeap(ctx, state, op, params);
  const plan = planSprint(ctx, state, op, params, opts);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  applySprint(ctx, state, op, plan, opts);
  rideThemDown(ctx, state, op, plan, params);
  return { ok: true };
}

registerAction({
  id: SPRINT,
  name: 'SPRINT',
  ap: 0,
  type: 'unique',
  sourceText: text(RULE.agility),
  available: (ctx, _state, op) => isMounted(ctx, op),
  check: (ctx, state, op, params) => sprintCheck(ctx, state, op, params),
  perform: (ctx, state, op, params) => {
    const r = sprintPerform(ctx, state, op, params, { label: 'Sprint' });
    if (!r.ok) return r;
    openContinuationWindows(state, op);
    return r;
  },
});

/**
 * TURN 1AP: "Pivot the active operative up to 45°. This doesn't use any of its movement
 * allowance." The pivot must be supplied — `params.data.pivotDeg` (±45) or a `targetPos` to
 * face — so `src/ai/legal.ts`'s parameter probes never produce a blind, AP-wasting Turn.
 */
registerAction({
  id: TURN,
  name: 'TURN',
  ap: 1,
  type: 'unique',
  sourceText: text(RULE.agility),
  available: (ctx, _state, op) => isMounted(ctx, op),
  check: (ctx, state, op, params) => {
    if (counteracting(state, op)) return { ok: false, reason: 'an operative cannot Turn while counteracting' };
    const pivot = pivotFrom(op, params);
    if (pivot === undefined) return { ok: false, reason: 'select a pivot of up to 45°' };
    const place = canPlaceAt(ctx, state, op, op.pos, op.z, op.rot + pivot);
    return place.ok ? { ok: true } : { ok: false, reason: place.reason ?? 'it cannot pivot there' };
  },
  perform: (ctx, state, op, params) => {
    const pivot = pivotFrom(op, params)!;
    op.rot += pivot;
    op.onGuard = false;
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter} performs Turn (${pivot.toFixed(0)}°)`,
      data: { operativeId: op.id, action: TURN, pivot },
    });
    markTreatedAs(ctx, state, op, 'Dash');
    return { ok: true };
  },
});

function pivotFrom(op: OperativeState, params: ActionParams): number | undefined {
  const raw = params.data?.['pivotDeg'];
  if (typeof raw === 'number' && Math.abs(raw) > EPS && Math.abs(raw) <= 45 + 1e-4) return raw;
  const at = params.targetPos;
  if (at && dist(op.pos, at) >= 0.5) {
    const want = angleOf(sub(at, op.pos));
    let delta = want - op.rot;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    const clamped = Math.max(-45, Math.min(45, delta));
    if (Math.abs(clamped) > EPS) return clamped;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// LEAP (firefight ploy) — "Instead of moving that operative…"
// ---------------------------------------------------------------------------

const leapArmed = (state: GameState, op: OperativeState): boolean => Boolean(effectOn(state, op.id, LEAP_ARMED));

interface LeapPlan {
  ok: boolean;
  reason?: string;
  pos?: Vec2;
  z?: number;
}

/**
 * "…remove it from the killzone and set it back up in a location it can be placed within 1"
 * horizontally of its original location. This distance cannot be measured through terrain
 * features more than 2" tall, and that operative cannot be set up on Vantage terrain higher
 * than 2" from the killzone floor."
 */
function planLeap(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): LeapPlan {
  const index = terrain(ctx, state);
  const candidates: Vec2[] = [];
  if (params.targetPos) candidates.push({ ...params.targetPos });
  const h = heading(op.rot);
  for (const step of [1, 0.75, 0.5]) {
    candidates.push({ x: op.pos.x + h.x * step, y: op.pos.y + h.y * step });
    candidates.push({ x: op.pos.x - h.x * step, y: op.pos.y - h.y * step });
    candidates.push({ x: op.pos.x + h.y * step, y: op.pos.y - h.x * step });
    candidates.push({ x: op.pos.x - h.y * step, y: op.pos.y + h.x * step });
  }
  for (const pos of candidates) {
    if (dist(op.pos, pos) > 1 + EPS) continue;
    const tall = index.parts.some((p) => p.z1 > 2 + EPS && segmentCrossesPoly(op.pos, pos, p.poly));
    if (tall) return { ok: false, reason: 'that distance cannot be measured through terrain more than 2" tall' };
    const z = surfaceAt(index, pos);
    if (z > 2 + EPS) continue; // "cannot be set up on Vantage terrain higher than 2""
    if (!canPlaceAt(ctx, state, op, pos, z, op.rot).ok) continue;
    return { ok: true, pos, z };
  }
  return { ok: false, reason: 'there is nowhere within 1" it can be set up' };
}

function performLeap(ctx: GameContext, state: GameState, op: OperativeState, params: ActionParams): { ok: boolean; reason?: string } {
  const plan = planLeap(ctx, state, op, params);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  dropEffects(state, (e) => e.rule === LEAP_ARMED && e.operativeId === op.id);
  op.pos = { ...plan.pos! };
  op.z = plan.z!;
  op.onGuard = false;
  // "That operative is treated as having moved 3" for the purposes of its movement allowance
  //  and has SPEED 3-."
  const led = ledgerOf(state, op);
  led.fwd += 3;
  led.tp += 3;
  setSpeed(state, op, 'low');
  log(state, { kind: 'ploy', player: op.player, text: `Leap: ${op.letter} is set back up within 1"` });
  markTreatedAs(ctx, state, op, 'Reposition');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Continuation Sprints: MOONSONG CULL, NOMAD EXECUTIONER, RIDING MASTERY
// ---------------------------------------------------------------------------

/**
 * NOMAD EXECUTIONER and RIDING MASTERY both let another action happen *inside* the Sprint and
 * then let "any remaining move distance it had from that Sprint action be used after it does
 * so". The engine cannot interleave actions, so the Sprint is split into two ActionDefs that
 * share one allowance (D-021), and this opens the window the second half needs.
 */
function openContinuationWindows(state: GameState, op: OperativeState): void {
  if (hasUpgrade(state, op, 'NOMAD EXECUTIONER')) {
    effect(state, {
      rule: NOMAD_WINDOW,
      source: { kind: 'ability', id: ABILITY.leystalkerUpgrades },
      sourceText: shortQuote(UPGRADE_TEXT['NOMAD EXECUTIONER']),
      operativeId: op.id,
      player: op.player,
      // "…for that Shoot action, this operative's SPEED is whatever it had before beginning
      //  the Sprint action." The Sprint has already ended here, so the previous level is kept.
      data: { speed: previousSpeed(state, op) },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  }
  if (ployUsed(state, op.player, FP.ridingMastery)) {
    effect(state, {
      rule: RIDING_WINDOW,
      source: { kind: 'ploy', id: FP.ridingMastery },
      sourceText: shortQuote(text(FP.ridingMastery)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  }
}

/** The SPEED the operative held before this activation's Sprint updated it. */
function previousSpeed(state: GameState, op: OperativeState): Speed {
  const store = bucket(state, `${SPEED_KEY}.previous`) as Record<string, Speed>;
  return store[op.id] ?? 'low';
}

registerAction({
  id: SPRINT_MOONSONG,
  name: 'SPRINT (Moonsong Cull)',
  ap: 0,
  type: 'unique',
  sourceText: `MOONSONG CULL: ${UPGRADE_TEXT['MOONSONG CULL']}`,
  available: (ctx, state, op) => isMounted(ctx, op) && hasUpgrade(state, op, 'MOONSONG CULL'),
  check(ctx, state, op, params) {
    const gate = moonsongGate(ctx, state, op);
    if (!gate.ok) return gate;
    return sprintCheck(ctx, state, op, params, { noPivot: true });
  },
  perform(ctx, state, op, params) {
    const gate = moonsongGate(ctx, state, op);
    if (!gate.ok) return gate;
    return sprintPerform(ctx, state, op, params, { noPivot: true, label: 'Sprint (Moonsong Cull)' });
  },
});

/**
 * "Once during each of this operative's activations, after it's performed the Sprint action
 * forwards and incapacitated an enemy operative during the Fight action, if it's no longer
 * within control range of enemy operatives… The operative cannot have performed any other
 * actions between those actions."
 */
function moonsongGate(ctx: GameContext, state: GameState, op: OperativeState): { ok: boolean; reason?: string } {
  if (!did(op, SPRINT)) return { ok: false, reason: 'it has not performed the Sprint action this activation' };
  if (ledgerOf(state, op).fwd <= 0) return { ok: false, reason: 'that Sprint was not forwards' };
  if (!effectOn(state, op.id, MOONSONG_KILL))
    return { ok: false, reason: 'it has not incapacitated an enemy operative during the Fight action' };
  if (enemiesInControlRange(ctx, state, op).length > 0)
    return { ok: false, reason: 'it is still within control range of an enemy operative' };
  // "…cannot have performed any other actions between those actions" — only the Fight may sit
  // between the Sprint and the free Sprint.
  const after = op.actionsThisActivation.slice(op.actionsThisActivation.lastIndexOf(SPRINT) + 1);
  if (after.some((a) => a !== 'Fight' && a !== 'Charge' && a !== 'Reposition' && a !== FIGHT_REACH))
    return { ok: false, reason: 'it performed another action between those actions' };
  return { ok: true };
}

registerAction({
  id: SPRINT_NOMAD,
  name: 'SPRINT (Nomad Executioner)',
  ap: 0,
  type: 'unique',
  sourceText: `NOMAD EXECUTIONER: ${UPGRADE_TEXT['NOMAD EXECUTIONER']}`,
  available: (ctx, state, op) => isMounted(ctx, op) && hasUpgrade(state, op, 'NOMAD EXECUTIONER'),
  check(ctx, state, op, params) {
    if (!effectOn(state, op.id, NOMAD_WINDOW))
      return { ok: false, reason: 'it has not performed the Sprint action this activation' };
    if (!did(op, 'Shoot')) return { ok: false, reason: 'it has not performed the Shoot action during that Sprint' };
    return sprintCheck(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    const r = sprintPerform(ctx, state, op, params, { label: 'Sprint (Nomad Executioner)' });
    if (r.ok) dropEffects(state, (e) => e.rule === NOMAD_WINDOW && e.operativeId === op.id);
    return r;
  },
});

registerAction({
  id: SPRINT_RIDING,
  name: 'SPRINT (Riding Mastery)',
  ap: 0,
  type: 'unique',
  sourceText: text(FP.ridingMastery),
  available: (ctx, _state, op) => isMounted(ctx, op),
  check(ctx, state, op, params) {
    if (!effectOn(state, op.id, RIDING_WINDOW))
      return { ok: false, reason: 'Riding Mastery was not used for this Sprint action' };
    const marker = ['Pick Up Marker', 'Place Marker'].some((a) => did(op, a));
    const mission = op.actionsThisActivation.some((a) => getAction(a)?.type === 'mission');
    if (!marker && !mission)
      return { ok: false, reason: 'it has not performed a marker or mission action during that Sprint' };
    return sprintCheck(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    const r = sprintPerform(ctx, state, op, params, { label: 'Sprint (Riding Mastery)' });
    if (r.ok) dropEffects(state, (e) => e.rule === RIDING_WINDOW && e.operativeId === op.id);
    return r;
  },
});

// ---------------------------------------------------------------------------
// Fight (Draconic Cavalry Tactics) — the widened control range
// ---------------------------------------------------------------------------

/**
 * "Whenever a friendly EXODITE DRAGON MASTER MOUNTED operative would perform the Fight action,
 * the distance requirements of its control range can be changed to 1" horizontally and 4"
 * vertically until the end of that action."
 *
 * The engine's control range is a 2D base gap of 1" plus a visibility test, so the only case in
 * which the printed change can add anything is one the core gate refuses. This sibling action
 * (D-021) is offered only then; the ordinary Fight keeps every other case.
 */
function reachTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const c = cardOfOp(ctx, op);
  return aliveOperatives(state)
    .filter((e) => e.player !== op.player && !e.incapacitated)
    .filter((e) => baseGap(op.pos, c.base, op.rot, e.pos, cardOfOp(ctx, e).base, e.rot) <= 1 + EPS)
    .filter((e) => Math.abs(e.z - op.z) <= 4 + EPS)
    .filter((e) => !enemiesInControlRange(ctx, state, op).some((x) => x.id === e.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

registerAction({
  id: FIGHT_REACH,
  name: 'Fight (Cavalry Reach)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Fight',
  sourceText: text(RULE.cavalry),
  available: (ctx, _state, op) => isMounted(ctx, op),
  check(ctx, state, op, params) {
    const candidates = reachTargets(ctx, state, op);
    if (candidates.length === 0)
      return { ok: false, reason: 'no enemy operative within 1" horizontally and 4" vertically' };
    const target = params.targetId ? candidates.find((e) => e.id === params.targetId) : candidates[0];
    if (!target) return { ok: false, reason: 'that operative is not within the changed control range' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const candidates = reachTargets(ctx, state, op);
    const target = (params.targetId ? candidates.find((e) => e.id === params.targetId) : candidates[0]) ?? candidates[0];
    if (!target) return { ok: false, reason: 'no enemy operative within the changed control range' };
    const weapon = params.meleeWeaponName ?? cardOfOp(ctx, op).weapons.find((w) => w.profiles.some((p) => p.type === 'melee'))?.name;
    if (!weapon) return { ok: false, reason: 'operative has no melee weapon' };
    const r = startFight(ctx, state, op, weapon, params.meleeProfileName, target.id, { hatchway: true });
    if (!r.ok) return r;
    advanceFight(ctx, state);
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Guard (Nexus Sentinel)
// ---------------------------------------------------------------------------

registerAction({
  id: GUARD_NEXUS,
  name: 'Guard (Nexus Sentinel)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Guard',
  sourceText: `NEXUS SENTINEL: ${UPGRADE_TEXT['NEXUS SENTINEL']}`,
  available: (ctx, state, op) => isMounted(ctx, op) && hasUpgrade(state, op, 'NEXUS SENTINEL'),
  check(ctx, state, op) {
    if (op.order === 'conceal') return { ok: false, reason: 'cannot go on Guard with a Conceal order' };
    if (enemiesInControlRange(ctx, state, op).length > 0)
      return { ok: false, reason: 'within control range of an enemy operative' };
    if (speedOf(state, op) !== 'low') return { ok: false, reason: 'it can only do this while it has SPEED 3-' };
    if (counteracting(state, op)) return { ok: false, reason: 'a counteraction cannot be the Guard action' };
    if (usedThisTP(state, `edm.nexusSentinel:${op.id}`))
      return { ok: false, reason: 'once per turning point' };
    return { ok: true };
  },
  perform(_ctx, state, op) {
    useOncePerTP(state, `edm.nexusSentinel:${op.id}`);
    op.onGuard = true;
    effect(state, {
      rule: NEXUS_GUARD,
      source: { kind: 'ability', id: ABILITY.leystalkerUpgrades },
      sourceText: shortQuote(UPGRADE_TEXT['NEXUS SENTINEL']),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(state, { kind: 'action', player: op.player, text: `${op.letter} goes on Guard (Nexus Sentinel)` });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Draconic Cavalry Tactics — cover and obscured
// ---------------------------------------------------------------------------

/**
 * "Each friendly EXODITE DRAGON MASTER MOUNTED operative cannot be in cover from or obscured by
 * Light terrain, terrain parts less than 2" tall or terrain that's not wholly intervening."
 *
 * Recomputed here rather than through `onValidTarget.ignoreCoverTerrain`, which can only drop
 * Light terrain: `CoverOpts.ignore` is set inside `coverAndObscured` and has no hook.
 */
function mountedCoverAndObscured(
  ctx: GameContext,
  state: GameState,
  shooter: OperativeState,
  target: OperativeState,
): { inCover: boolean; obscured: boolean } {
  const index = terrain(ctx, state);
  const a = body(ctx, shooter);
  const b = body(ctx, target);
  const inter = interveningParts(index, a, b);
  const wholly = new Set(inter.wholly.map((p) => p.id));
  const qualifies = (p: IndexedPart): boolean =>
    wholly.has(p.id) && p.z1 >= 2 - EPS && !(hasType(p, 'Light') && !hasType(p, 'Heavy'));
  const gap = baseGap(a.pos, a.base, a.rot, b.pos, b.base, b.rot);
  const inCover =
    gap > 2 + EPS &&
    inter.any.some((p) => qualifies(p) && baseDistanceToPart(b.pos, b.base, b.rot, p) <= 1 + EPS);
  const obscured = inter.any.some(
    (p) =>
      qualifies(p) &&
      hasType(p, 'Heavy') &&
      baseDistanceToPart(a.pos, a.base, a.rot, p) > 1 + EPS &&
      baseDistanceToPart(b.pos, b.base, b.rot, p) > 1 + EPS,
  );
  return { inCover, obscured };
}

// ---------------------------------------------------------------------------
// Faction rules + datacard abilities
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const mounted = (op: OperativeState): boolean => T.mineKw(op, KW) && T.kw(op, MOUNTED);

  // ---- Drakesteed Agility: the four banned universal actions -------------
  reg.on('canPerformAction', T.bind(RULE.agility, 10), (ev) => {
    if (!mounted(ev.operative)) return;
    if (!['Charge', 'Dash', 'Fall Back', 'Reposition'].includes(ev.action)) return;
    ev.allowed = false;
    ev.reason = 'EXODITE DRAGON MASTER MOUNTED operatives perform the Sprint and Turn actions instead';
  });

  // ---- Draconic Cavalry Tactics: two activations per turning point -------
  reg.on('onActivationStart', T.bind(RULE.cavalry, 6), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    // Per-activation Sprint allowance resets; the per-turning-point one does not.
    const led = ledgerOf(ev.state, op);
    led.fwd = 0;
    led.back = 0;
    if (!mounted(op)) return;
    const acts = bucket(ev.state, ACTIVATIONS_KEY) as Record<string, number>;
    acts[op.id] = (acts[op.id] ?? 0) + 1;
  });

  reg.on('onActivationEnd', T.bind(RULE.cavalry, 6), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player) return;
    const apTP = bucket(ev.state, AP_TP_KEY) as Record<string, number>;
    apTP[op.id] = (apTP[op.id] ?? 0) + op.apSpent;
    if (!mounted(op) || op.removed || op.incapacitated) return;
    const acts = bucket(ev.state, ACTIVATIONS_KEY) as Record<string, number>;
    if ((acts[op.id] ?? 0) >= 2) return;
    // "…is activated twice per turning point (it's only expended after the second activation)."
    op.ready = true;
    op.expended = false;
    log(ev.state, { kind: 'system', player: T.player, text: `${op.letter} is activated twice per turning point` });
  });

  reg.on('onReadyStep', T.bind(RULE.cavalry, 6), (ev) => {
    if (ev.player !== T.player) return;
    const acts = bucket(ev.state, ACTIVATIONS_KEY) as Record<string, number>;
    const apTP = bucket(ev.state, AP_TP_KEY) as Record<string, number>;
    for (const op of T.friendlies(ev.state)) {
      acts[op.id] = 0;
      apTP[op.id] = 0;
      const led = ledgerOf(ev.state, op);
      led.fwd = 0;
      led.back = 0;
      led.tp = 0;
    }
  });

  // "You cannot spend more than 3AP for it per activation, or more than its APL stat per
  //  turning point."
  reg.on('canPerformAction', T.bind(RULE.cavalry, 7), (ev) => {
    const op = ev.operative;
    if (!mounted(op) || counteracting(ev.state, op)) return;
    const def = getAction(ev.action);
    if (!def) return;
    const ap = T.ctx ? actionCost(T.ctx, ev.state, op, def) : def.ap;
    if (op.apSpent + ap > 3) {
      ev.allowed = false;
      ev.reason = 'you cannot spend more than 3AP for it per activation';
      return;
    }
    const apl = T.ctx ? aplOf(T.ctx, ev.state, op) : (T.card(op)?.apl ?? 4);
    const spentTP = Number((bucket(ev.state, AP_TP_KEY) as Record<string, number>)[op.id] ?? 0);
    if (spentTP + op.apSpent + ap > apl) {
      ev.allowed = false;
      ev.reason = 'you cannot spend more than its APL stat for it per turning point';
    }
  });

  // "…cannot be in cover from or obscured by Light terrain, terrain parts less than 2" tall or
  //  terrain that's not wholly intervening."
  reg.on('onValidTarget', T.bind(RULE.cavalry, 8), (ev) => {
    if (!mounted(ev.target) || !T.ctx) return;
    const from = ev.viewFrom ?? ev.attacker;
    if (!mountedCoverAndObscured(T.ctx, ev.state, from, ev.target).inCover) ev.ignoreCoverTerrain = 'all';
  });
  reg.on('onCollectAttackDice', T.bind(RULE.cavalry, 8), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.ctx) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.obscured) return;
    const target = ev.ctx.defender;
    if (!target || !mounted(target)) return;
    if (mountedCoverAndObscured(T.ctx, ev.state, ev.ctx.attacker, target).obscured) return;
    seq.obscured = false;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${target.letter} cannot be obscured by that terrain (Draconic Cavalry Tactics)`,
    });
  });

  // ---- Mercurial Speed ---------------------------------------------------
  // "It ends its activation without performing the Sprint action" -> SPEED 3-.
  reg.on('onActivationEnd', T.bind(RULE.speed, 9), (ev) => {
    const op = ev.operative;
    if (!mounted(op)) return;
    const sprinted = [SPRINT, SPRINT_MOONSONG, SPRINT_NOMAD, SPRINT_RIDING].some((a) => did(op, a));
    if (!sprinted) setSpeed(ev.state, op, 'low');
  });
  // Remember the level held before this activation's Sprint (NOMAD EXECUTIONER reads it).
  reg.on('onActivationStart', T.bind(RULE.speed, 5), (ev) => {
    if (!T.mine(ev.operative)) return;
    (bucket(ev.state, `${SPEED_KEY}.previous`) as Record<string, Speed>)[ev.operative.id] = speedOf(
      ev.state,
      ev.operative,
    );
  });

  // "Whenever an operative is shooting a friendly EXODITE DRAGON MASTER operative, if that
  //  friendly operative has SPEED 4+, you can retain one of your defence dice as a normal
  //  success without rolling it; if it has SPEED 7+, you can retain one as a critical success."
  reg.on('onDefenceDice', T.bind(RULE.speed, 10), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    const speed = speedOf(ev.state, target);
    if (speed === 'low') return;
    autoRetainDefenceDie(ev, target, speed === 'high' ? 'crit' : 'normal', `Mercurial Speed (${SPEED_LABEL[speed]})`);
  });

  // ---- CLANBLADE › Scaleshield ------------------------------------------
  // "Whenever an operative is shooting this operative, and no attack dice are retained as
  //  critical successes, worsen the x of the Piercing weapon rule by 1 (if any)."
  reg.on('onWeaponRules', T.bind(ABILITY.scaleshield, 10), (ev) => {
    if (ev.type !== 'ranged') return;
    const target = ev.target;
    if (!target || target.player !== T.player || target.datacardId !== CARD.clanblade) return;
    const seq = shootSeq(ev.state);
    // The retained crits are only known once the attack pool is rolled and retained.
    if (!seq || seq.targetId !== target.id) return;
    if (!['rollDefence', 'defenceRerolls', 'allocate', 'resolve'].includes(seq.step)) return;
    if (countCrits(seq.attack) > 0) return;
    ev.rules = ev.rules.flatMap((r) => {
      if (r.id !== 'Piercing') return [r];
      const x = (r.x ?? 1) - 1;
      // "Note that Piercing 1 would therefore be ignored."
      return x > 0 ? [ruleTag('Piercing', x, `Piercing ${x} (Scaleshield)`)] : [];
    });
  });

  // ---- LEYSTALKER › Aimed (rare weapon rule) -----------------------------
  // "This operative cannot use this weapon during an activation in which it moved more than 3",
  //  and it cannot move more than 3" during an activation in which it used this weapon."
  // The Sprint owns its own allowance, so the second half is a cap on it (`sprintAllowance`).
  // "This weapon rule has no effect on preventing the Guard action" needs nothing: the gate is
  // on selecting the weapon profile, never on an action.
  reg.on('onSelectWeapon', T.bind(ABILITY.aimed, 10), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player) return;
    if (!ev.ctx.profile.rules.some((r) => r.id === 'Aimed')) return;
    const led = ledgerOf(ev.state, op);
    if (led.fwd + led.back > 3 + EPS) {
      ev.allowed = false;
      ev.reason = 'Aimed: it moved more than 3" during this activation';
      return;
    }
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (D-032)
    if (effectOn(ev.state, op.id, AIMED_USED)) return;
    effect(ev.state, {
      rule: AIMED_USED,
      source: { kind: 'weapon', id: ABILITY.aimed },
      sourceText: shortQuote(abilityText(CARD.leystalker, ABILITY.aimed)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });

  // ---- LEYSTALKER › Implacable Darkscale ---------------------------------
  // "You can ignore any changes to this operative's drakesteed fangs & talons weapon's Hit stat
  //  from being injured." `onStatMod` is per operative, so the weapon comes from the sequence.
  reg.on('onStatMod', T.bind(ABILITY.implacable, 10), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.leystalker) return;
    if (!T.ctx || !isInjured(T.ctx, op)) return;
    // SURVIVALIST SPIRIT already cancels the injured Hit change; two cancellations would
    // over-correct it, and "you can ignore" never improves a stat beyond its printed value.
    if (effectOn(ev.state, op.id, SURVIVALIST)) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const name = seq.attackerId === op.id ? seq.attackerWeapon : seq.defenderId === op.id ? seq.defenderWeapon : undefined;
    if (!name || !/drakesteed fangs/i.test(name)) return;
    ev.mods.hit += 1; // cancels "worsen the Hit stat of their weapons by 1"
  });

  // ---- DRAKOLITHE › Preternatural Evasion --------------------------------
  reg.on('onMoveDistance', T.bind(ABILITY.preternatural, 4), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.drakolithe) return;
    if (!['Charge', 'Fall Back', 'Reposition'].includes(ev.action)) return;
    settleEvasion(ev.state, op);
    // Idempotent: the operative has not moved between the AI's probes and the real call.
    const store = bucket(ev.state, EVASION_KEY) as Record<string, { from?: Vec2; gained?: boolean }>;
    store[op.id] = { ...(store[op.id] ?? {}), from: { ...op.pos } };
  });
  reg.on('onActivationEnd', T.bind(ABILITY.preternatural, 5), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.drakolithe) return;
    settleEvasion(ev.state, op);
    const store = bucket(ev.state, EVASION_KEY) as Record<string, { from?: Vec2; gained?: boolean }>;
    // "Whenever this operative ends its activation, if it didn't gain SPEED 4+ or SPEED 7+
    //  during that activation, it has SPEED 3-."
    if (!store[op.id]?.gained) setSpeed(ev.state, op, 'low');
    store[op.id] = {};
  });

  // ---- DRAKOLITHE › Beast ------------------------------------------------
  reg.on('canPerformAction', T.bind(ABILITY.beast, 10), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.drakolithe) return;
    const def = getAction(ev.action);
    const key = def?.treatedAs ?? ev.action;
    const isMission = def?.type === 'mission';
    const allowed = BEAST_ACTIONS.includes(key) || BEAST_ACTIONS.includes(ev.action) || isMission;
    if (!allowed) {
      ev.allowed = false;
      ev.reason = 'Beast: this operative cannot perform that action';
      return;
    }
    // "…cannot perform the Pick Up Marker, Place Marker or mission actions unless there's a
    //  friendly LEYSTALKER operative that isn't incapacitated."
    const needsHandler = isMission || key === 'Pick Up Marker' || key === 'Place Marker';
    if (!needsHandler) return;
    const leystalker = T.friendlies(ev.state).some((o) => o.datacardId === CARD.leystalker && !o.incapacitated);
    if (!leystalker) {
      ev.allowed = false;
      ev.reason = 'Beast: no friendly LEYSTALKER operative that isn’t incapacitated';
    }
  });

  registerClanbladeUpgrades(reg, T);
  registerLeystalkerUpgrades(reg, T);
  registerStonesingerUpgrades(reg, T);
}

const BEAST_ACTIONS = [
  'Charge',
  'Dash',
  'Fall Back',
  'Fight',
  'Guard',
  'Pick Up Marker',
  'Place Marker',
  'Reposition',
];

/**
 * "…if it ends that action more than 2" from its previous location, it has SPEED 4+; if it ends
 * more than 5" from its previous location, it has SPEED 7+ instead. Note that it's the distance
 * from the previous location, not the distance moved."
 *
 * The engine runs nothing at the end of an action, so the pre-move position is recorded at
 * `onMoveDistance` (which `validateMove` emits before every move) and settled lazily — from
 * `speedOf`, the single reader of a SPEED, and from `onActivationEnd`. The settle is a pure
 * function of (recorded position, current position), so a lazy call is idempotent and
 * deterministic no matter how often it runs.
 */
function settleEvasion(state: GameState, op: OperativeState): void {
  if (op.datacardId !== CARD.drakolithe) return;
  const store = bucket(state, EVASION_KEY) as Record<string, { from?: Vec2; gained?: boolean }>;
  const rec = store[op.id];
  if (!rec?.from) return;
  const moved = dist(rec.from, op.pos);
  if (moved <= 2 + EPS) return;
  delete rec.from;
  rec.gained = true;
  setSpeed(state, op, moved > 5 + EPS ? 'high' : 'mid');
}

/**
 * "…you can retain one of your defence dice as a normal success without rolling it" — one die
 * fewer is rolled at the Roll Defence Dice step and the retained die is pushed into the pool at
 * the post-roll `onDefenceDice` emit, the only hook that sees it (the Elucidian ARMOURED
 * UNDERSUIT / Ratlings IMPROVISED ARMOUR precedent: there is no defence-retention hook).
 */
function autoRetainDefenceDie(
  ev: { state: GameState; count: number; coverSave: boolean },
  target: OperativeState,
  as: 'normal' | 'crit',
  note: string,
): void {
  const seq = shootSeq(ev.state);
  if (!seq || seq.targetId !== target.id) return;
  const key = `${target.id}:${note}`;
  const stamp = `${seq.attackerId}:${seq.targetId}:${seq.resolvedTargets.length}`;
  const b = bucket(ev.state, 'edm.autoRetain') as Record<string, string>;
  if (seq.step === 'rollDefence') {
    if (b[key] === stamp) return;
    ev.count = Math.max(0, ev.count - 1);
    return;
  }
  if (seq.step !== 'defenceRerolls') return;
  if (b[key] === stamp) return;
  b[key] = stamp;
  const die = addAutoNormal(seq.defence, 1, note)[0]!;
  if (as === 'crit') die.state = 'crit';
  log(ev.state, {
    kind: 'dice',
    player: target.player,
    text: `${target.letter} retains one defence dice as a ${as === 'crit' ? 'critical' : 'normal'} success (${note})`,
  });
}

// ---------------------------------------------------------------------------
// Clanblade Upgrades
// ---------------------------------------------------------------------------

function registerClanbladeUpgrades(reg: HookRegistry, T: TeamHooks): void {
  const upgraded = (state: GameState, op: OperativeState, u: Upgrade): boolean =>
    op.player === T.player && op.datacardId === CARD.clanblade && hasUpgrade(state, op, u);

  // ---- SPECTRAL NIMBUS --------------------------------------------------
  // "…your opponent cannot retain attack dice results of less than 6 as critical successes
  //  during that sequence (e.g. as a result of the Lethal, Rending or Severe weapon rules)."
  // Lethal is applied when the pool is classified and Severe/Rending at retention, so both are
  // expressed by stripping them from the enemy's weapon for the sequence. The printed moment
  // ("after your opponent rolls their attack dice, but before re-rolls") is shifted earlier;
  // the outcome is identical because neither rule can be applied before the roll.
  reg.on('onWeaponRules', T.bind(ABILITY.clanbladeUpgrades, 11), (ev) => {
    if (ev.type !== 'melee') return;
    const foe = ev.operative;
    if (foe.player === T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const mine = [seq.attackerId, seq.defenderId]
      .map((id) => ev.state.operatives[id])
      .find((o) => o && upgraded(ev.state, o, 'SPECTRAL NIMBUS'));
    if (!mine) return;
    if (!ev.rules.some((r) => ['Lethal', 'Rending', 'Severe'].includes(r.id))) return;
    const key = `edm.spectralNimbus:${T.player}`;
    const stamp = `${seq.attackerId}:${seq.defenderId}:${ev.state.turningPoint}`;
    const claimed = bucket(ev.state, 'edm.spectralNimbusSeq') as Record<string, string>;
    if (claimed[key] !== stamp) {
      if (usedThisTP(ev.state, key)) return;
      useOncePerTP(ev.state, key);
      claimed[key] = stamp;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `Spectral Nimbus: ${mine.letter}'s attacker cannot retain results of less than 6 as critical successes`,
      });
    }
    ev.rules = ev.rules.filter((r) => !['Lethal', 'Rending', 'Severe'].includes(r.id));
  });

  // ---- FOCUSED REFLECTION -----------------------------------------------
  // Snapshot the pools before allocation; the engine tells no hook which defence dice blocked.
  reg.on('onDefenceDice', T.bind(ABILITY.clanbladeUpgrades, 11), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !upgraded(ev.state, target, 'FOCUSED REFLECTION')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls') return;
    (bucket(ev.state, FOCUSED_SNAPSHOT) as Record<string, unknown>)[target.id] = {
      atkCrits: countCrits(seq.attack),
      atkNormals: countNormals(seq.attack),
      defCrits: countCrits(seq.defence),
      defNormals: countNormals(seq.defence),
      dmgN: ev.ctx.profile.dmgN,
      dmgC: ev.ctx.profile.dmgC,
      brutal: hasRule(ev.ctx.rules, 'Brutal'),
    };
  });
  reg.on('onStrikeResolved', T.bind(ABILITY.clanbladeUpgrades, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.ctx) return;
    const target = ev.struck;
    if (!upgraded(ev.state, target, 'FOCUSED REFLECTION')) return;
    const store = bucket(ev.state, FOCUSED_SNAPSHOT) as Record<string, Record<string, number | boolean> | undefined>;
    const snap = store[target.id];
    delete store[target.id];
    if (!snap) return;
    const shooter = ev.ctx.attacker;
    if (T.gap(shooter, target) > 6 + EPS) return; // "while within 6" of it"
    const alloc = allocateSavesOptimally(
      Number(snap['atkCrits']),
      Number(snap['atkNormals']),
      Number(snap['defCrits']),
      Number(snap['defNormals']),
      Number(snap['dmgN']),
      Number(snap['dmgC']),
      Boolean(snap['brutal']),
    );
    const critBlocks = alloc.critBlocksCrit + alloc.critBlocksNormal;
    if (critBlocks <= 0) return;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Focused Reflection: ${shooter.letter} takes ${critBlocks}`,
    });
    inflictDamage(T.ctx, ev.state, shooter, critBlocks, 'other');
  });

  // ---- SPEARTIP OF THE CLAN ---------------------------------------------
  reg.on('onStrikeResolved', T.bind(ABILITY.clanbladeUpgrades, 11), (ev) => {
    if (ev.ctx.type !== 'melee' || ev.crit || !T.ctx) return;
    const me = ev.ctx.attacker;
    if (!upgraded(ev.state, me, 'SPEARTIP OF THE CLAN')) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== me.id) return; // "whenever this operative is FIGHTING"
    const speed = speedOf(ev.state, me);
    // "If it has SPEED 4+, the FIRST time you strike with a normal success during that sequence,
    //  inflict 1 additional damage. If it has SPEED 7+, add 1 to the Normal Dmg stat of melee
    //  weapons on its datacard" (i.e. every normal strike). D-019: applied where the damage is
    //  inflicted, never by rewriting the shared profile.
    if (speed === 'mid') {
      if (!useOncePerSequence(ev.state, `${SPEARTIP_USED}:${me.id}`)) return;
    } else if (speed !== 'high') {
      return;
    }
    log(ev.state, { kind: 'dice', player: T.player, text: `Speartip of the Clan: +1 damage (${SPEED_LABEL[speed]})` });
    inflictDamage(T.ctx, ev.state, ev.struck, 1, 'attack');
  });

  // ---- BLADED STANCE ----------------------------------------------------
  // "…you can resolve one of your successes before the normal order." The second half ("that
  // success must be used to block") is unenforceable: the engine builds the strike/block
  // options itself (the Celestian / Elucidian / Spectre Bladed Stance precedent).
  reg.on('onCollectAttackDice', T.bind(ABILITY.clanbladeUpgrades, 11), (ev) => {
    if (ev.ctx.type !== 'melee') return;
    const me = ev.ctx.attacker;
    if (!upgraded(ev.state, me, 'BLADED STANCE')) return;
    if (!/moonblades/i.test(ev.ctx.weaponName)) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    seq.turn = seq.attackerId === me.id ? 'attacker' : 'defender';
  });
}

// ---------------------------------------------------------------------------
// Leystalker Upgrades
// ---------------------------------------------------------------------------

function registerLeystalkerUpgrades(reg: HookRegistry, T: TeamHooks): void {
  const upgraded = (state: GameState, op: OperativeState, u: Upgrade): boolean =>
    op.player === T.player && op.datacardId === CARD.leystalker && hasUpgrade(state, op, u);

  // ---- ELUSIVE PHANTASM --------------------------------------------------
  // "At the end of each Firefight phase, if this operative isn't within control range of enemy
  //  operatives, it can perform a free Sprint or Turn action, but it cannot move more than 3"
  //  during that action and its SPEED remains the same."
  reg.on('onEndOfTP', T.bind(ABILITY.leystalkerUpgrades, 11), (ev) => {
    const ctx = T.ctx;
    if (!ctx) return;
    for (const op of T.friendlies(ev.state)) {
      if (!upgraded(ev.state, op, 'ELUSIVE PHANTASM')) continue;
      if (enemiesInControlRange(ctx, ev.state, op).length > 0) continue;
      const plan = planSprint(ctx, ev.state, op, {}, { cap: 3 });
      if (!plan.ok) continue;
      applySprint(ctx, ev.state, op, plan, { label: 'Sprint (Elusive Phantasm)', keepSpeed: true });
    }
  });

  // ---- FATED SHOT --------------------------------------------------------
  // "Once per turning point, when this operative performs the Shoot action and you select a
  //  profile of its long rifle, you can use this rule."
  reg.on('onSelectWeapon', T.bind(ABILITY.leystalkerUpgrades, 11), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (D-032)
    const op = ev.ctx.attacker;
    if (!upgraded(ev.state, op, 'FATED SHOT')) return;
    if (!/long rifle/i.test(ev.ctx.weaponName)) return;
    if (!useOncePerTP(ev.state, `edm.fatedShot:${op.id}`)) return;
    // D-016: the two printed options have no decision channel, so the choice is deterministic
    // and logged — the friendly-control-range option only when it is the one that matters.
    const target = ev.ctx.defender;
    const ctx = T.ctx;
    const blocked =
      target !== undefined &&
      ctx !== undefined &&
      aliveOperatives(ev.state, T.player).some((f) => f.id !== op.id && inControlRange(ctx, ev.state, f, target));
    const choice = blocked ? 'control-range' : 'no-obscured';
    effect(ev.state, {
      rule: FATED_SHOT,
      source: { kind: 'ability', id: ABILITY.leystalkerUpgrades },
      sourceText: shortQuote(UPGRADE_TEXT['FATED SHOT']),
      operativeId: op.id,
      player: T.player,
      data: { choice },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Fated Shot: ${choice}` });
  });
  reg.on('onValidTarget', T.bind(ABILITY.leystalkerUpgrades, 12), (ev) => {
    const eff = effectOn(ev.state, ev.attacker.id, FATED_SHOT);
    if (!eff || ev.attacker.player !== T.player) return;
    if (eff.data?.['choice'] === 'control-range') ev.ignoreFriendlyControlRange = true;
  });
  reg.on('onCollectAttackDice', T.bind(ABILITY.leystalkerUpgrades, 12), (ev) => {
    const seq = shootSeq(ev.state);
    if (!seq) return;
    const eff = effectOn(ev.state, ev.ctx.attacker.id, FATED_SHOT);
    if (!eff || eff.data?.['choice'] !== 'no-obscured' || !seq.obscured) return;
    seq.obscured = false;
    log(ev.state, { kind: 'action', player: T.player, text: 'Fated Shot: enemy operatives cannot be obscured' });
  });

  // ---- NEXUS SENTINEL: keeping the granted Guard armed -------------------
  // The reducer clears `onGuard` after every action whose id is not literally `Guard`
  // (`src/core/reducer.ts` › PerformAction), so the granted action's own `perform` cannot make
  // it stick. It is re-armed at the end of the activation — which is before the enemy
  // activation the interrupt belongs to — and only while the Guard was the LAST action, so
  // "it performs any action, moves or is set up" still ends it.
  reg.on('onActivationEnd', T.bind(ABILITY.leystalkerUpgrades, 11), (ev) => {
    const op = ev.operative;
    if (!upgraded(ev.state, op, 'NEXUS SENTINEL')) return;
    if (!effectOn(ev.state, op.id, NEXUS_GUARD)) return;
    if (op.actionsThisActivation[op.actionsThisActivation.length - 1] !== 'Guard') return;
    op.onGuard = true;
  });

  // ---- NEXUS SENTINEL: the point-blank Hit clause ------------------------
  // "Whenever this operative performs a pointblank shot as a result of the Guard action, don't
  //  worsen the Hit stat of its weapons as a result of performing a point-blank shot."
  reg.on('onStatMod', T.bind(ABILITY.leystalkerUpgrades, 11), (ev) => {
    const op = ev.operative;
    if (!upgraded(ev.state, op, 'NEXUS SENTINEL')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== op.id || !seq.pointBlank) return;
    ev.mods.hit += 1;
  });

  // ---- GLOAMING MANTLE ---------------------------------------------------
  // "Whenever an operative is shooting this operative from more than 8" away, if you cannot
  //  retain any cover saves, you can retain one of your defence dice as a normal success
  //  without rolling it; if you can retain any cover saves, you can retain one cover save as a
  //  critical success instead."
  reg.on('onDefenceDice', T.bind(ABILITY.leystalkerUpgrades, 11), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !upgraded(ev.state, target, 'GLOAMING MANTLE')) return;
    if (ev.ctx.distance <= 8 + EPS) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    if (seq.inCover && !hasRule(ev.ctx.rules, 'Saturate')) {
      if (seq.step === 'rollDefence') ev.coverSaveAsCrit = true;
      return;
    }
    autoRetainDefenceDie(ev, target, 'normal', 'Gloaming Mantle');
  });
}

// ---------------------------------------------------------------------------
// Stonesinger Upgrades
// ---------------------------------------------------------------------------

function registerStonesingerUpgrades(reg: HookRegistry, T: TeamHooks): void {
  const upgraded = (state: GameState, op: OperativeState, u: Upgrade): boolean =>
    op.player === T.player && op.datacardId === CARD.stonesinger && hasUpgrade(state, op, u);

  // ---- SOW THE SEEDS -----------------------------------------------------
  // "Once per turning point, during this operative's activation, before or after it performs an
  //  action, you can use this rule." There is no intent for "use a rule now", and it is free, so
  //  it is auto-used at the start of the activation on a stated policy (D-022): the lowest-id
  //  objective marker the STONESINGER controls.
  reg.on('onActivationStart', T.bind(ABILITY.stonesingerUpgrades, 11), (ev) => {
    const op = ev.operative;
    const ctx = T.ctx;
    if (!ctx || !upgraded(ev.state, op, 'SOW THE SEEDS')) return;
    if (!useOncePerTP(ev.state, `edm.sowTheSeeds:${op.id}`)) return;
    const marker = Object.values(ev.state.markers)
      .filter((m) => m.kind === 'objective' && markerController(ctx, ev.state, m) === T.player)
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (!marker) return;
    sowTheSeeds(ev.state, op.id, marker.id);
  });
  reg.on('onMarkerControl', T.bind(ABILITY.stonesingerUpgrades, 11), (ev) => {
    const ctx = T.ctx;
    if (!ctx) return;
    const eff = ev.state.effects.find((e) => e.rule === SOW_THE_SEEDS && e.player === T.player);
    if (!eff || eff.data?.['markerId'] !== ev.markerId) return;
    const op = eff.operativeId ? ev.state.operatives[eff.operativeId] : undefined;
    if (!op || op.removed || op.incapacitated) {
      dropEffects(ev.state, (e) => e === eff);
      return;
    }
    // "…treated as contesting that marker with an APL of 1 … (even if it's not within this
    //  operative's control range)."
    ev.aplByPlayer[T.player] += 1;
  });

  // ---- WAILS OF THE WORLD: the -2" Move change ---------------------------
  // "Subtract 2" from the Move stat of that operative … until the end of their next
  //  activations respectively (this isn't cumulative with being injured)."
  reg.on('onStatMod', T.bind(ABILITY.stonesingerUpgrades, 11), (ev) => {
    // Scoped to the STONESINGER's own player, so a mirror match does not subtract twice.
    const mine = ev.state.effects.some(
      (e) => e.rule === WAILS_SLOW && e.operativeId === ev.operative.id && e.player === T.player,
    );
    if (mine) ev.mods.move -= 2;
  });

  // ---- WIND'S GRACE: the effect's own lifetime ---------------------------
  reg.on('onActivationStart', T.bind(ABILITY.stonesingerUpgrades, 12), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.stonesinger) return;
    // "Until the start of this operative's first activation in the next turning point…"
    dropEffects(
      ev.state,
      (e) => e.rule === WINDS_GRACE && e.player === T.player && Number(e.data?.['tp'] ?? 0) < ev.state.turningPoint,
    );
  });
  reg.on('onIncapacitated', T.bind(ABILITY.stonesingerUpgrades, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.stonesinger) return;
    dropEffects(ev.state, (e) => e.rule === WINDS_GRACE && e.player === T.player);
  });

  // ---- EARTHEN WRATH -----------------------------------------------------
  // "This operative has the following ranged weapon: Earthen Wrath." `grantedWeapons` is kept
  // equal to exactly the legal set on every read, so the UI, `shotPlans` and `startShoot` can
  // never disagree (the Elucidian PRIVATEER SUPPORT ASSETS precedent).
  reg.on('availableWeapons', T.bind(ABILITY.stonesingerUpgrades, 11), (ev) => {
    const op = ev.operative;
    if (op.player !== T.player || op.datacardId !== CARD.stonesinger) return;
    const holder = op as OperativeState & { grantedWeapons?: Weapon[] };
    const want = hasUpgrade(ev.state, op, 'EARTHEN WRATH');
    holder.grantedWeapons = want ? [EARTHEN_WRATH_WEAPON] : [];
  });
  // "*Earthen Wrath: If the target is in cover, this weapon has the Lethal 5+ weapon rule."
  reg.on('onWeaponRules', T.bind(ABILITY.stonesingerUpgrades, 12), (ev) => {
    if (ev.weaponName !== EARTHEN_WRATH_WEAPON.name || ev.operative.player !== T.player) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.inCover) return;
    if (ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Earthen Wrath)'));
  });
}

/**
 * SOW THE SEEDS, as a pure setter so the UI can pick the marker: "select one objective marker
 * it controls. Until this operative is incapacitated, until you use this rule again or until an
 * enemy operative controls that marker…"
 */
export function sowTheSeeds(state: GameState, operativeId: string, markerId: string): { ok: boolean; reason?: string } {
  const op = state.operatives[operativeId];
  if (!op) return { ok: false, reason: 'no such operative' };
  const marker = state.markers[markerId];
  if (!marker || marker.kind !== 'objective') return { ok: false, reason: 'select one objective marker' };
  dropEffects(state, (e) => e.rule === SOW_THE_SEEDS && e.player === op.player);
  effect(state, {
    rule: SOW_THE_SEEDS,
    source: { kind: 'ability', id: ABILITY.stonesingerUpgrades },
    sourceText: shortQuote(UPGRADE_TEXT['SOW THE SEEDS']),
    operativeId: op.id,
    player: op.player,
    data: { markerId },
    expiry: { kind: 'endOfBattle' },
  });
  log(state, { kind: 'action', player: op.player, text: `Sow the Seeds: ${op.letter} claims ${markerId}` });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const mounted = (op: OperativeState): boolean => T.mineKw(op, KW) && T.kw(op, MOUNTED);

  // ---- WIND-SWIFT PRECISION (strategy, 1CP) ------------------------------
  // "Whenever a friendly EXODITE DRAGON MASTER operative is shooting, if it has SPEED 4+, its
  //  ranged weapons have the Balanced weapon rule."
  reg.on('onWeaponRules', T.bind(SP.windSwift, 20), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!gambitUsed(ev.state, T.player, SP.windSwift)) return;
    if (speedOf(ev.state, ev.operative) !== 'mid') return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Wind-Swift Precision)'));
  });

  // ---- DRACONIC FURY (strategy, 1CP) -------------------------------------
  reg.on('onWeaponRules', T.bind(SP.draconicFury, 20), (ev) => {
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW)) return;
    if (!gambitUsed(ev.state, T.player, SP.draconicFury)) return;
    const speed = speedOf(ev.state, ev.operative);
    if (speed === 'mid') ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Draconic Fury)'));
    else if (speed === 'high') ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Draconic Fury)'));
  });

  // ---- SINUOUS FLUX (strategy, 1CP) --------------------------------------
  // "Whenever an enemy operative is shooting a friendly EXODITE DRAGON MASTER operative more
  //  than 6" from it, if that friendly operative has SPEED 4+ or SPEED 7+, your opponent cannot
  //  re-roll their attack dice."
  reg.on('onRollAttack', T.bind(SP.sinuousFlux, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.sinuousFlux)) return;
    if (ev.ctx.type !== 'ranged') return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (ev.ctx.attacker.player === T.player) return;
    if (ev.ctx.distance <= 6 + EPS) return;
    if (speedOf(ev.state, target) === 'low') return;
    if (ev.rerolls.length === 0) return;
    ev.rerolls = [];
    log(ev.state, { kind: 'dice', player: T.player, text: 'Sinuous Flux: your opponent cannot re-roll their attack dice' });
  });

  // ---- RIDE THEM DOWN (strategy, 1CP) ------------------------------------
  // Resolved inside the Sprint action itself (`rideThemDown`), because the printed trigger is
  // "whenever it ends its move during the Sprint action" and nothing runs at the end of an action.

  // ---- SURVIVALIST SPIRIT (firefight, 1CP) -------------------------------
  reg.on('onPloyUsed', T.bind(FP.survivalistSpirit, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.survivalistSpirit) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const pool = T.friendlies(ev.state).filter((o) => T.kw(o, MOUNTED));
    const chosen = active && mounted(active) ? active : chosenOperative(ev.state, ev.data, pool);
    if (!chosen) return;
    effect(ev.state, {
      rule: SURVIVALIST,
      source: { kind: 'ploy', id: FP.survivalistSpirit },
      sourceText: shortQuote(text(FP.survivalistSpirit)),
      operativeId: chosen.id,
      player: T.player,
      data: { tp: ev.state.turningPoint },
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Survivalist Spirit: ${chosen.letter} ignores injured` });
  });
  // "Until the start of its next activation" — the ploy is used DURING an activation (or a
  // counteraction), so the next `onActivationStart` this operative sees is that moment exactly.
  reg.on('onActivationStart', T.bind(FP.survivalistSpirit, 21), (ev) => {
    dropEffects(ev.state, (e) => e.rule === SURVIVALIST && e.operativeId === ev.operative.id);
  });
  // "…you can ignore any changes to that operative's weapon stats from being injured."
  reg.on('onStatMod', T.bind(FP.survivalistSpirit, 21), (ev) => {
    if (!T.mine(ev.operative) || !effectOn(ev.state, ev.operative.id, SURVIVALIST)) return;
    if (!T.ctx || !isInjured(T.ctx, ev.operative)) return;
    ev.mods.hit += 1; // the Hit stat is the only weapon stat being injured changes
  });

  // ---- LEAP (firefight, 1CP) ---------------------------------------------
  reg.on('onPloyUsed', T.bind(FP.leap, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.leap) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const pool = T.friendlies(ev.state).filter((o) => T.kw(o, MOUNTED));
    const chosen = active && mounted(active) ? active : chosenOperative(ev.state, ev.data, pool);
    if (!chosen) return;
    effect(ev.state, {
      rule: LEAP_ARMED,
      source: { kind: 'ploy', id: FP.leap },
      sourceText: shortQuote(text(FP.leap)),
      operativeId: chosen.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Leap: ${chosen.letter}'s next Sprint is a leap` });
  });

  // ---- FERAL HUNGER (firefight, 1CP) -------------------------------------
  // "Use this firefight ploy after rolling your attack dice for a friendly EXODITE DRAGON
  //  MASTER operative, if it's fighting against a wounded enemy operative with its Drakesteed
  //  fangs & talons or fangs & talons. You can re-roll any of your attack dice."
  // `fight.ts` builds its re-roll grants from the weapon's rules AFTER rolling, so Relentless
  // granted here is exactly "re-roll any of your attack dice" at the printed moment.
  reg.on('onWeaponRules', T.bind(FP.feralHunger, 20), (ev) => {
    if (ev.type !== 'melee' || ev.retaliating) return;
    if (!T.mineKw(ev.operative, KW)) return;
    if (!ployUsed(ev.state, T.player, FP.feralHunger)) return;
    if (!/fangs & talons/i.test(ev.weaponName)) return;
    const foe = ev.target;
    if (!foe || !T.ctx) return;
    const card = T.card(foe);
    if (!card || foe.wounds >= card.wounds) return; // "a wounded enemy operative"
    if (ev.rules.some((r) => r.id === 'Relentless')) return;
    ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Feral Hunger)'));
  });

  // ---- RIDING MASTERY (firefight, 1CP) -----------------------------------
  // The continuation Sprint is `SPRINT (Riding Mastery)`; the window is opened by the Sprint
  // action itself (`openContinuationWindows`).
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  const mounted = (op: OperativeState): boolean => T.mineKw(op, KW) && T.kw(op, MOUNTED);

  // ---- DRAGONSCALE MESH --------------------------------------------------
  // "Once per turning point, when an operative is shooting a friendly EXODITE DRAGON MASTER
  //  MOUNTED operative, in the Roll Defence Dice step, you can retain one of your normal
  //  successes as a critical success instead." Free, so auto-used (D-022).
  reg.on('onDefenceDice', T.bind(EQ.dragonscaleMesh, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.dragonscaleMesh)) return;
    const target = ev.ctx.defender;
    if (!target || !mounted(target)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.step !== 'defenceRerolls' || seq.targetId !== target.id) return;
    const die = seq.defence.dice.find((d) => d.state === 'normal');
    if (!die) return;
    if (!useOncePerTP(ev.state, `edm.dragonscale:${T.player}`)) return;
    die.state = 'crit';
    die.note = 'Dragonscale Mesh';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `${target.letter}: Dragonscale Mesh retains a normal success as a critical success`,
    });
  });

  // ---- CLAN TALISMANS ----------------------------------------------------
  // "Once per turning point, when a friendly EXODITE DRAGON MASTER MOUNTED operative is
  //  shooting, fighting or retaliating, if you roll two or more fails, you can discard one of
  //  them to retain another as a normal success instead."
  // Applied at the Retention step, which `onWeaponRules` is emitted at for BOTH sequences —
  // so all three printed cases are live, and the transform is exact rather than the D-018
  // `mode: 'fails'` re-roll approximation. Free, so auto-used (D-022).
  reg.on('onWeaponRules', T.bind(EQ.clanTalismans, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.clanTalismans)) return;
    if (!mounted(ev.operative)) return;
    const seq = ev.state.sequence;
    if (!seq || seq.step !== 'retention') return;
    const pool =
      seq.kind === 'shoot'
        ? seq.attackerId === ev.operative.id
          ? seq.attack
          : undefined
        : seq.attackerId === ev.operative.id
          ? seq.attackerPool
          : seq.defenderId === ev.operative.id
            ? seq.defenderPool
            : undefined;
    if (!pool) return;
    const fails = pool.dice.filter((d) => d.state === 'fail');
    if (fails.length < 2) return;
    if (!useOncePerTP(ev.state, `edm.clanTalismans:${T.player}`)) return;
    const sorted = [...fails].sort((a, b) => a.value - b.value);
    sorted[0]!.state = 'discarded';
    sorted[0]!.note = 'Clan Talismans (discarded)';
    sorted[1]!.state = 'normal';
    sorted[1]!.note = 'Clan Talismans';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Clan Talismans: ${ev.operative.letter} discards a fail to retain another as a normal success`,
    });
  });

  // ---- LILEATHAN CRYSTAL MATRICES ----------------------------------------
  reg.on('onSelectWeapon', T.bind(EQ.lileathan, 30), (ev) => {
    if (ev.dryRun) return; // a `check` is a legality query — never mutate (D-032)
    if (!hasEquipment(ev.state, T.player, EQ.lileathan)) return;
    const op = ev.ctx.attacker;
    if (!T.mineKw(op, KW)) return;
    if (!/^(solar carbine|long rifle)$/i.test(ev.ctx.weaponName.trim())) return;
    if (!useOncePerTP(ev.state, `edm.lileathan:${T.player}`)) return;
    effect(ev.state, {
      rule: LILEATHAN,
      source: { kind: 'equipment', id: EQ.lileathan },
      sourceText: shortQuote(text(EQ.lileathan)),
      operativeId: op.id,
      player: T.player,
      data: { weapon: ev.ctx.weaponName },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'action', player: T.player, text: `Lileathan Crystal Matrices: ${ev.ctx.weaponName} has Piercing 1` });
  });
  reg.on('onWeaponRules', T.bind(EQ.lileathan, 31), (ev) => {
    const eff = effectOn(ev.state, ev.operative.id, LILEATHAN);
    if (!eff || eff.data?.['weapon'] !== ev.weaponName) return;
    if (ev.rules.some((r) => r.id === 'Piercing')) return;
    ev.rules.push(ruleTag('Piercing', 1, 'Piercing 1 (Lileathan Crystal Matrices)'));
  });

  // ---- SPIRIT STONES -----------------------------------------------------
  reg.on('onIncapacitated', T.bind(EQ.spiritStones, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.spiritStones)) return;
    if (!mounted(ev.operative)) return;
    ev.state.teams[T.player].cp += 1;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Spirit Stones: ${ev.operative.letter} falls — gain 1CP` });
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

function actions(data: TeamData): ActionDef[] {
  return [
    // SONG OF RENEWAL 1AP — STONESINGER
    uniqueAction(data, CARD.stonesinger, SONG_OF_RENEWAL, {
      check: (ctx, state, op, params) => {
        const gate = psychicGate(ctx, state, op, `edm.songOfRenewal:${op.id}`);
        if (!gate.ok) return gate;
        if (renewalMode(params) === 'all') return { ok: true };
        const target = renewalTarget(ctx, state, op, params);
        return target
          ? { ok: true }
          : { ok: false, reason: 'select one friendly EXODITE DRAGON MASTER operative visible to this operative' };
      },
      perform: (ctx, state, op, params) => {
        useOncePerTP(state, `edm.songOfRenewal:${op.id}`);
        if (renewalMode(params) === 'all') {
          // "Alternatively, each friendly EXODITE DRAGON MASTER operative can regain up to D3."
          for (const friend of aliveOperatives(state, op.player).sort((a, b) => (a.id < b.id ? -1 : 1))) {
            if (!keywordsOf(ctx, friend).includes(KW)) continue;
            const d3 = ctx.rng.d3();
            recordRoll(state, 'songOfRenewal', [d3], op.player, `SONG OF RENEWAL ${friend.letter}`);
            heal(ctx, state, friend, d3);
          }
          return { ok: true };
        }
        const target = renewalTarget(ctx, state, op, params)!;
        const a = ctx.rng.d3();
        const b = ctx.rng.d3();
        recordRoll(state, 'songOfRenewal', [a, b], op.player, `SONG OF RENEWAL 2D3 ${target.letter}`);
        heal(ctx, state, target, a + b);
        return { ok: true };
      },
    }),

    // WAILS OF THE WORLD 1AP — STONESINGER upgrade
    {
      id: ACT_WAILS,
      name: ACT_WAILS,
      ap: upgradeActionAp('WAILS OF THE WORLD'),
      type: 'unique',
      sourceText: `${ACT_WAILS}: ${UPGRADE_TEXT['WAILS OF THE WORLD']}`,
      available: (_ctx, state, op) => op.datacardId === CARD.stonesinger && hasUpgrade(state, op, 'WAILS OF THE WORLD'),
      check(ctx, state, op, params) {
        const gate = psychicGate(ctx, state, op, `edm.wails:${op.id}`);
        if (!gate.ok) return gate;
        return wailsTarget(ctx, state, op, params)
          ? { ok: true }
          : { ok: false, reason: 'select one enemy operative visible to this operative' };
      },
      perform(ctx, state, op, params) {
        const primary = wailsTarget(ctx, state, op, params)!;
        useOncePerTP(state, `edm.wails:${op.id}`);
        const victims = aliveOperatives(state)
          .filter((o) => o.player !== op.player && !o.incapacitated)
          .filter((o) => o.id === primary.id || baseGap(primary.pos, cardOfOp(ctx, primary).base, primary.rot, o.pos, cardOfOp(ctx, o).base, o.rot) <= 2 + EPS)
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        for (const victim of victims) {
          // "MOUNTED operatives are unaffected."
          if (keywordsOf(ctx, victim).includes(MOUNTED)) continue;
          const card = cardOfOp(ctx, victim);
          // "(this isn't cumulative with being injured)" — the injured -2" already applies.
          const injured = victim.wounds < card.wounds / 2;
          if (!injured) {
            effect(state, {
              rule: WAILS_SLOW,
              source: { kind: 'ability', id: ABILITY.stonesingerUpgrades },
              sourceText: shortQuote(UPGRADE_TEXT['WAILS OF THE WORLD']),
              operativeId: victim.id,
              player: op.player,
              expiry: { kind: 'endOfNextActivation', operativeId: victim.id, armed: false },
            });
          }
          const newMove = Math.max(4, card.move - 2);
          const a = ctx.rng.d3();
          const b = ctx.rng.d3();
          recordRoll(state, 'wailsOfTheWorld', [a, b], op.player, `WAILS OF THE WORLD vs ${victim.letter}`);
          // "inflict damage on that operative equal to the difference between the result and
          //  their new Move stat" — the shortfall, never a negative.
          const damage = Math.max(0, a + b - newMove);
          if (damage > 0) inflictDamage(ctx, state, victim, damage, 'other');
        }
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: WAILS OF THE WORLD` });
        return { ok: true };
      },
    },

    // CLEANSING OF THE PALE MOON 1AP — STONESINGER upgrade
    {
      id: ACT_CLEANSING,
      name: ACT_CLEANSING,
      ap: upgradeActionAp('CLEANSING OF THE PALE MOON'),
      type: 'unique',
      sourceText: `${ACT_CLEANSING}: ${UPGRADE_TEXT['CLEANSING OF THE PALE MOON']}`,
      available: (_ctx, state, op) =>
        op.datacardId === CARD.stonesinger && hasUpgrade(state, op, 'CLEANSING OF THE PALE MOON'),
      check(ctx, state, op, params) {
        // "…it can perform this action more than once per turning point."
        if (enemiesInControlRange(ctx, state, op).length > 0)
          return { ok: false, reason: 'within control range of an enemy operative' };
        const target = friendlyDragonMasterTarget(ctx, state, op, params);
        if (!target) return { ok: false, reason: 'select one friendly EXODITE DRAGON MASTER operative visible to this operative' };
        return cleansingVictim(state, target) ? { ok: true } : { ok: false, reason: 'nothing your opponent applied to remove' };
      },
      perform(ctx, state, op, params) {
        const target = friendlyDragonMasterTarget(ctx, state, op, params)!;
        const victim = cleansingVictim(state, target);
        if (!victim) return { ok: false, reason: 'nothing to remove' };
        if (victim.kind === 'effect') {
          dropEffects(state, (e) => e.id === victim.id);
          log(state, { kind: 'action', player: op.player, text: `Cleansing of the Pale Moon: ${target.letter} loses ${victim.label}` });
        } else {
          const idx = target.aplMods.findIndex((m) => m < 0);
          if (idx >= 0) target.aplMods.splice(idx, 1);
          log(state, { kind: 'action', player: op.player, text: `Cleansing of the Pale Moon: ${target.letter} loses ${victim.label}` });
        }
        return { ok: true };
      },
    },

    // WIND'S GRACE 1AP — STONESINGER upgrade
    {
      id: ACT_WINDS_GRACE,
      name: ACT_WINDS_GRACE,
      ap: upgradeActionAp(ACT_WINDS_GRACE),
      type: 'unique',
      sourceText: `${ACT_WINDS_GRACE}: ${UPGRADE_TEXT[ACT_WINDS_GRACE]}`,
      available: (_ctx, state, op) => op.datacardId === CARD.stonesinger && hasUpgrade(state, op, ACT_WINDS_GRACE),
      check(ctx, state, op, params) {
        const gate = psychicGate(ctx, state, op, `edm.windsGrace:${op.id}`);
        if (!gate.ok) return gate;
        return friendlyDragonMasterTarget(ctx, state, op, params)
          ? { ok: true }
          : { ok: false, reason: 'select one friendly EXODITE DRAGON MASTER operative visible to this operative' };
      },
      perform(ctx, state, op, params) {
        const target = friendlyDragonMasterTarget(ctx, state, op, params)!;
        useOncePerTP(state, `edm.windsGrace:${op.id}`);
        // "…or until it performs this action again (whichever comes first)".
        dropEffects(state, (e) => e.rule === WINDS_GRACE && e.player === op.player);
        effect(state, {
          rule: WINDS_GRACE,
          source: { kind: 'ability', id: ABILITY.stonesingerUpgrades },
          sourceText: shortQuote(UPGRADE_TEXT[ACT_WINDS_GRACE]),
          operativeId: target.id,
          player: op.player,
          data: { tp: state.turningPoint },
          expiry: { kind: 'endOfBattle' },
        });
        log(state, { kind: 'action', player: op.player, text: `Wind’s Grace: ${target.letter}'s SPEED is one higher` });
        return { ok: true };
      },
    },
  ];
}

/** "This operative cannot perform this action while within control range … or more than once per turning point." */
function psychicGate(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  key: string,
): { ok: boolean; reason?: string } {
  if (enemiesInControlRange(ctx, state, op).length > 0)
    return { ok: false, reason: 'within control range of an enemy operative' };
  if (usedThisTP(state, key)) return { ok: false, reason: 'once per turning point' };
  return { ok: true };
}

const renewalMode = (params: ActionParams): 'one' | 'all' =>
  params.choice === 'all' || params.data?.['mode'] === 'all' ? 'all' : 'one';

function visibleTo(ctx: GameContext, state: GameState, from: OperativeState, to: OperativeState): boolean {
  return isVisible(terrain(ctx, state), body(ctx, from), body(ctx, to)).visible;
}

function friendlyDragonMasterTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState | undefined {
  const candidates = aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && !o.incapacitated && keywordsOf(ctx, o).includes(KW))
    .filter((o) => visibleTo(ctx, state, op, o))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const wanted = params.targetOperativeId ?? params.targetId;
  if (typeof wanted === 'string') return candidates.find((o) => o.id === wanted);
  return candidates[0];
}

function renewalTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState | undefined {
  const wanted = params.targetOperativeId ?? params.targetId;
  // The STONESINGER may heal itself: "select one friendly … operative visible to this operative".
  if (wanted === op.id) return op;
  return friendlyDragonMasterTarget(ctx, state, op, params) ?? (wanted === undefined ? op : undefined);
}

function wailsTarget(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: ActionParams,
): OperativeState | undefined {
  const candidates = aliveOperatives(state)
    .filter((o) => o.player !== op.player && !o.incapacitated)
    .filter((o) => visibleTo(ctx, state, op, o))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const wanted = params.targetOperativeId ?? params.targetId;
  if (typeof wanted === 'string') return candidates.find((o) => o.id === wanted);
  return candidates[0];
}

/** "Remove one rules effect or stat change your opponent has applied to it." */
function cleansingVictim(
  state: GameState,
  target: OperativeState,
): { kind: 'effect' | 'apl'; id: string; label: string } | undefined {
  const eff = state.effects
    .filter((e) => e.operativeId === target.id && e.player !== undefined && e.player !== target.player)
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  if (eff) return { kind: 'effect', id: eff.id, label: eff.rule };
  if (target.aplMods.some((m) => m < 0)) return { kind: 'apl', id: target.id, label: '-1APL' };
  return undefined;
}

function heal(ctx: GameContext, state: GameState, op: OperativeState, amount: number): void {
  const max = cardOfOp(ctx, op).wounds;
  const before = op.wounds;
  op.wounds = Math.min(max, op.wounds + amount);
  if (op.wounds !== before)
    log(state, { kind: 'action', player: op.player, text: `${op.letter} regains ${op.wounds - before} lost wounds` });
}

// ---------------------------------------------------------------------------
// MOONSONG CULL bookkeeping: "…and incapacitated an enemy operative during the Fight action"
// ---------------------------------------------------------------------------

function moonsongBookkeeping(reg: HookRegistry, T: TeamHooks): void {
  reg.on('onIncapacitated', T.bind(ABILITY.clanbladeUpgrades, 10), (ev) => {
    const victim = ev.operative;
    if (victim.player === T.player) return;
    const seq = fightSeq(ev.state);
    if (!seq) return;
    const killer = [seq.attackerId, seq.defenderId]
      .map((id) => ev.state.operatives[id])
      .find((o) => o && o.player === T.player && o.datacardId === CARD.clanblade && hasUpgrade(ev.state, o, 'MOONSONG CULL'));
    if (!killer) return;
    if (effectOn(ev.state, killer.id, MOONSONG_KILL)) return;
    effect(ev.state, {
      rule: MOONSONG_KILL,
      source: { kind: 'ability', id: ABILITY.clanbladeUpgrades },
      sourceText: shortQuote(UPGRADE_TEXT['MOONSONG CULL']),
      operativeId: killer.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: killer.id },
    });
  });
}

// ---------------------------------------------------------------------------

export const exoditeDragonMasters = defineTeam({
  id: 'exodite-dragon-masters',
  rules: (reg, T) => {
    rules(reg, T);
    moonsongBookkeeping(reg, T);
  },
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "Use this firefight ploy during a friendly EXODITE DRAGON MASTER MOUNTED operative's
    //  activation or counteraction, before or after it performs an action."
    [FP.survivalistSpirit]: (state, player) =>
      aliveOperatives(state, player).some((o) => o.player === player && !o.removed)
        ? { ok: true }
        : { ok: false, reason: 'no friendly operative' },
    // "Use this firefight ploy when a friendly EXODITE DRAGON MASTER MOUNTED operative performs
    //  the Sprint action."
    [FP.leap]: (state, player) =>
      aliveOperatives(state, player).some((o) => o.ready || o.id === state.activeOperativeId)
        ? { ok: true }
        : { ok: false, reason: 'no friendly operative can Sprint' },
    // "Use this firefight ploy after rolling your attack dice for a friendly EXODITE DRAGON
    //  MASTER operative, if it's fighting against a wounded enemy operative…" The grant rides
    // `onWeaponRules`, which `offerRerolls` reads AFTER the roll, so declaring it any time
    // during the activation produces the printed effect (see the notes on the timing shift).
    [FP.feralHunger]: (state, player) => {
      const seq = state.sequence;
      if (seq?.kind === 'fight')
        return state.operatives[seq.attackerId]?.player === player
          ? { ok: true }
          : { ok: false, reason: 'no friendly operative is fighting in that sequence' };
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active?.player === player
        ? { ok: true }
        : { ok: false, reason: 'use it during a friendly operative’s activation' };
    },
    [FP.ridingMastery]: (state, player) =>
      state.activeOperativeId && state.operatives[state.activeOperativeId]?.player === player
        ? { ok: true }
        : { ok: false, reason: 'use it during a friendly operative’s activation' },
  },
  aiHints: {
    roles: {
      [CARD.clanblade]: 'melee',
      [CARD.leystalker]: 'sniper',
      [CARD.stonesinger]: 'support',
      [CARD.drakolithe]: 'scout',
    },
    ployValue: {
      [SP.windSwift]: 0.5,
      [SP.draconicFury]: 0.6,
      [SP.sinuousFlux]: 0.5,
      [SP.rideThemDown]: 0.6,
      [FP.survivalistSpirit]: 0.4,
      [FP.leap]: 0.3,
      [FP.feralHunger]: 0.6,
      [FP.ridingMastery]: 0.4,
    },
    equipmentValue: {
      [EQ.dragonscaleMesh]: 0.6,
      [EQ.clanTalismans]: 0.6,
      [EQ.lileathan]: 0.5,
      [EQ.spiritStones]: 0.4,
    },
  },
});

export default exoditeDragonMasters;
