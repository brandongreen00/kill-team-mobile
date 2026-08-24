/**
 * TEMPESTUS AQUILONS — Astra Militarum.
 * https://wahapedia.ru/kill-team3/kill-teams/tempestus-aquilons/
 *
 * Rule text is read from `data/teams/tempestus-aquilons.json` and never retyped; every hook
 * carries a short verbatim quote of the printed rule in its `RuleBinding`.
 *
 * Eight datacards, two faction rules, twelve datacard abilities, one unique action and two rare
 * weapon rules (`ConcealedPosition`, `Salvo`). Everything hangs off three shapes:
 *
 *  - **Set up above.** Drop Insertion prints "place them to one side instead of in the killzone"
 *    and then "friendly TEMPESTUS AQUILON operatives set up above are **activated as normal**",
 *    which is the Raveners' Burrow shape exactly: there is no reserve / off-killzone operative
 *    state in the engine, and none is needed. An operative set up above stays `removed: false`
 *    (so it activates through the ordinary alternating order) and is parked off the killzone
 *    floor at negative coordinates — literally "to one side". Control range, marker contesting,
 *    assists, Blast footprints, territory and drop-zone tests then all answer "no" with no extra
 *    hook, `canPerformAction` supplies "you can either expend or land that operative" (nothing
 *    but LAND is legal up there) and one `onValidTarget` refusal stops a Range-less weapon
 *    shooting it across the void. The parking spot keeps `x > -50` because `FinishSetup` treats
 *    `pos.x < -50` as "not deployed".
 *    *Which* operatives start above is the Select Operatives gap every batch has hit: there is
 *    no decision channel there, so it goes through the pure setter `setAbove` (D-017). Nothing
 *    is above until it is called, which makes the printed setup clause — and with it the Drop
 *    markers, ADJUST COORDINATES, DROP AUGURY and Swift Landing — inert in AI-driven games.
 *    Everything else in Drop Insertion is live the moment `setAbove` is used.
 *
 *  - **Landing is a real action.** "The operative is treated as performing the Reposition action
 *    (spend the AP accordingly)" makes LAND a 1AP `ActionDef` with `treatedAs: 'Reposition'`
 *    (D-021). Its placement resolver is shared by `check` and `perform` so nothing `check`
 *    accepts can be refused later (D-026), and the three printed radii — 3" base, 4" for a
 *    TROOPER (Swift Landing) and 5" under ADJUST COORDINATES — are one number in that resolver.
 *
 *  - **Grav-Chute has no seam at all.** "Whenever a friendly TEMPESTUS AQUILON operative is
 *    dropping, ignore the vertical distance" is `onMoveRules.ignoreDropInches`, which is
 *    declared but NEVER emitted (`validateMove` keeps its `legs` to itself). Registering
 *    against it would be the silent no-op CLAUDE.md architecture rule 5 forbids, so the whole
 *    rule is reminder-only — the same gap both Phobos REIVERs, the Deathwatch Headtaker and
 *    the Scout Squad's Grapnel Launcher reported.
 */
import { getAction, registerAction, type ActionDef } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { devastatingDamage, fails, successes } from '../../core/dice.ts';
import {
  EXPLOSIVE_ID,
  GRENADE_WEAPON_NAMES,
  grenadeAllowance,
  grenadeWeapon,
  withGrenadeBudgetIgnored,
} from '../../core/equipment/grenades.ts';
import { baseGap, basePerimeter, baseRadius, baseWhollyWithin, basesOverlap, dist, distancePointToPoly, pointInPoly } from '../../core/geometry.ts';
import type { HookRegistry, RerollGrant } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import { checkTarget, effectiveRules, validTargets } from '../../core/sequences/shoot.ts';
import type { FightSequence, ShootSequence } from '../../core/sequences/types.ts';
import {
  aliveOperatives,
  body,
  card as cardOf,
  findProfile,
  inflictDamage,
  log,
  markerContestedBy,
  modelHeight,
  moveOf,
  recordRoll,
  removeIncapacitated,
  weaponsOf,
} from '../../core/state.ts';
import { baseBlockedByTerrain, baseTouchesHazardous, hasType, occupancyCapExceeded, surfaceAt, type TerrainIndex } from '../../core/terrain.ts';
import type {
  BaseShape,
  GameState,
  MarkerState,
  OperativeState,
  PlayerId,
  Poly,
  Vec2,
  Weapon,
} from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { isOnVantage, isVisible, withinControlRange } from '../../core/visibility.ts';
import { teamData, type TeamData } from '../data.ts';
import {
  bucket,
  catalogueCard,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  effectsOn,
  FREE_ACTION_RULE,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  usedThisBattle,
  type TeamHooks,
} from '../helpers.ts';

const DATA: TeamData = teamData('tempestus-aquilons');

export const KW = 'TEMPESTUS AQUILON';
const EPS = 1e-6;
const DEFAULT_BASE: BaseShape = { shape: 'round', mm: 32 };

export const CARD = {
  tempestor: 'tempestus-aquilons.aquilon-tempestor',
  grenadier: 'tempestus-aquilons.aquilon-grenadier',
  gunfighter: 'tempestus-aquilons.aquilon-gunfighter',
  gunner: 'tempestus-aquilons.aquilon-gunner',
  marksman: 'tempestus-aquilons.aquilon-marksman',
  precursor: 'tempestus-aquilons.aquilon-precursor',
  servoSentry: 'tempestus-aquilons.aquilon-servo-sentry',
  trooper: 'tempestus-aquilons.aquilon-trooper',
} as const;

export const RULE = {
  dropInsertion: 'tempestus-aquilons.rule.drop-insertion',
  gravChute: 'tempestus-aquilons.rule.grav-chute',
} as const;

export const AB = {
  veteran: 'tempestus-aquilons.aquilon-tempestor.tempestus-veteran',
  grenadier: 'tempestus-aquilons.aquilon-grenadier.grenadier',
  salvo: 'tempestus-aquilons.aquilon-gunfighter.salvo',
  gunfight: 'tempestus-aquilons.aquilon-gunfighter.gunfight',
  snipersVantage: 'tempestus-aquilons.aquilon-marksman.snipers-vantage',
  concealedPosition: 'tempestus-aquilons.aquilon-marksman.concealed-position',
  viciousKnifeFighter: 'tempestus-aquilons.aquilon-precursor.vicious-knife-fighter',
  dynamic: 'tempestus-aquilons.aquilon-precursor.dynamic',
  machine: 'tempestus-aquilons.aquilon-servo-sentry.machine',
  turret: 'tempestus-aquilons.aquilon-servo-sentry.turret',
  rapidInsertion: 'tempestus-aquilons.aquilon-trooper.rapid-insertion',
  swiftLanding: 'tempestus-aquilons.aquilon-trooper.swift-landing',
} as const;

export const ACT = { command: 'tempestus-aquilons.aquilon-tempestor.act.command' } as const;

export const SP = {
  suddenOffensive: 'tempestus-aquilons.sp.sudden-offensive',
  maintainMomentum: 'tempestus-aquilons.sp.maintain-momentum',
  eyeAbove: 'tempestus-aquilons.sp.eye-above',
  dropAndSecure: 'tempestus-aquilons.sp.drop-and-secure',
} as const;

export const FP = {
  hotDrop: 'tempestus-aquilons.fp.hot-drop',
  adjustCoordinates: 'tempestus-aquilons.fp.adjust-coordinates',
  tempestusExemplars: 'tempestus-aquilons.fp.tempestus-exemplars',
  progena: 'tempestus-aquilons.fp.progena',
} as const;

export const EQ = {
  tempestusDaggers: 'tempestus-aquilons.eq.tempestus-daggers',
  combatStimms: 'tempestus-aquilons.eq.combat-stimms',
  dropAugury: 'tempestus-aquilons.eq.drop-augury',
  remoteOverseer: 'tempestus-aquilons.eq.remote-overseer',
} as const;

/** Action ids. LAND is printed inside the Drop Insertion faction rule, not on a datacard. */
export const LAND = 'Land (Drop Insertion)';
export const SHOOT_TURRET = 'Shoot (Turret)';
export const SHOOT_GUNFIGHT = 'Shoot (Gunfight)';
export const DASH_DYNAMIC = 'Dash (Dynamic)';
export const REPOSITION_RAPID = 'Reposition (Rapid Insertion)';
export const SMOKE_GRENADIER = 'Smoke Grenade (Aquilon Grenadier)';
export const STUN_GRENADIER = 'Stun Grenade (Aquilon Grenadier)';

/** The two extra 0CP STRATEGIC GAMBITs this team offers beside its four strategy ploys. */
export const DROP_MARKER_GAMBIT = 'tempestus-aquilons.gambit.move-drop-markers';
export const RAPID_INSERTION_GAMBIT = AB.rapidInsertion;

/** Tokens and effects (never module-level mutable state — architecture rule 7). */
export const ABOVE = 'tempestus-aquilons.above';
export const DETECTED_TOKEN = 'tempestus-aquilons.detected';
export const LANDED_OBSCURED = 'tempestus-aquilons.landedObscured';
const LANDED = 'tempestus-aquilons.landed';
const ADJUSTED = 'tempestus-aquilons.adjustCoordinates';
const EXEMPLARS = 'tempestus-aquilons.exemplars';
const PROGENA_APL = 'tempestus-aquilons.progena';
const ACTIVATION_MARK = 'tempestus-aquilons.activationMark';
const DROP_SECURE = 'tempestus-aquilons.dropAndSecure';
const SUDDEN = 'tempestus-aquilons.suddenOffensive';
const GUNFIGHT_DEBT = 'tempestus-aquilons.gunfightDebt';
const GUNFIGHT_SHOT = 'tempestus-aquilons.gunfightShot';
const PLOY_SUBJECT = 'tempestus-aquilons.ploySubject';
const ACTIVATION_ORDINAL = 'tempestus-aquilons.activationOrdinal';
const SHOT_ONCE = 'tempestus-aquilons.shot';
const SALVO_SECOND = 'tempestus-aquilons.salvoSecond';
const HOT_DROP_ARMED = 'tempestus-aquilons.hotDropArmed';

/**
 * Printed clauses this module does NOT implement, with the engine reason. Exported so the tests
 * can pin every one of them (docs/TEAM-STATUS.md is only worth anything if it is honest).
 */
export const REMINDER_ONLY: Record<string, string> = {
  [RULE.gravChute]:
    'the whole rule is onMoveRules.ignoreDropInches, and onMoveRules is declared but NEVER emitted — validateMove keeps its per-leg climb/drop knowledge to itself, so registering here would be the silent no-op architecture rule 5 forbids (the Phobos REIVER / Deathwatch Headtaker / Scout Squad Grapnel Launcher gap)',
  [`${RULE.dropInsertion}.setup`]:
    'Select Operatives has no decision channel, so which thirds are set up above goes through the pure setter setAbove (D-017) and nothing is above in an AI-driven game; the Drop markers it places, and every rule that reads them, are inert until it is called',
  [`${RULE.dropInsertion}.halfByTP1`]:
    '"Less than half of your operatives can be set up above by the end of the first turning point" is a restriction on when the player must land, and no hook can refuse the end of an activation or compel an action — the violation is detected and logged at the end of turning point 1, nothing more',
  [`${AB.veteran}.commandRerollFight`]:
    'fight.ts emits no post-roll hook at all (D-031), so the Command Re-roll discount reaches a shoot attack roll and a defence roll only — a melee Command Re-roll is offered by offerRerolls with no seam to price it',
  [`${AB.gunfight}.timing`]:
    'nothing runs at the end of an action and onIncapacitated.freeActions is never consumed, so "after the action, before incapacitated operatives are removed (including this one, if relevant)" becomes D-100\'s free AP on the GUNFIGHTER\'s own next activation (the Spectre Elite Fieldcraft shape); a GUNFIGHTER incapacitated by that shot never fires back, and "you can change its order to Engage to do so" is subsumed by the order it chooses when it activates',
  [`${AB.viciousKnifeFighter}.block`]:
    'the engine builds the strike/block options inside resolveFightDie, so the immediately-resolved second dice is always taken as a strike — "you can immediately resolve another" cannot be offered as a choice (the Celestian Bladed Stance / Deathwatch Adaptive Swordsmanship / Farstalker Stealth Attack precedent)',
  [EQ.remoteOverseer]:
    'initiativeRollModifiers is emitted BEFORE the D6 and rollInitiative never consults rerollOffered, so an initiative re-roll has no expression at all (the Raveners Heightened Senses / Phobos Tactical Advantage gap)',
  [`${FP.hotDrop}.fight`]:
    'onRollAttack is emitted by shoot.ts ONLY (D-031), so "after rolling your attack dice" reaches a shooting attack roll and not a fight or a retaliation',
};

// ---------------------------------------------------------------------------
// Printed text
// ---------------------------------------------------------------------------

/**
 * DATA BUG (already handled by the shared normaliser): two entries in the committed JSON carry
 * the REST OF THE PAGE glued onto their text — the strategy ploy DROP AND SECURE swallows all
 * four firefight ploys AND all four equipment entries, and the firefight ploy PROGENA swallows
 * the four equipment entries. Both also gain a spurious `weapons` array (the Tempestus dagger
 * table from the equipment section). `trimTrailingSection` in `src/teams/data.ts` cuts at the
 * section heading, so `teamData()` already hands back the ploy and nothing else; the ids of the
 * swallowed entries are intact in their own arrays, so nothing is lost. Both halves are pinned
 * by tests against the raw bytes.
 */
export function printed(id: string): string {
  const raw = [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find(
    (r) => r.id === id,
  );
  if (!raw) throw new Error(`No printed rule '${id}' in data/teams/tempestus-aquilons.json`);
  return raw.text;
}

export const abilityText = (cardId: string, abilityId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.abilities.find((a) => a.id === abilityId)!.text;

const actionText = (cardId: string, actionId: string): string =>
  DATA.datacards.find((c) => c.id === cardId)!.uniqueActions.find((a) => a.id === actionId)!.text;

// ---------------------------------------------------------------------------
// Small shared readers
// ---------------------------------------------------------------------------

const baseOf = (op: OperativeState): BaseShape => catalogueCard(op.datacardId)?.base ?? DEFAULT_BASE;

const isAquilon = (op: OperativeState): boolean =>
  (catalogueCard(op.datacardId)?.keywords ?? []).includes(KW);

const did = (op: OperativeState, action: string): boolean => op.actionsThisActivation.includes(action);

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

const fightSeq = (state: GameState): FightSequence | undefined =>
  state.sequence?.kind === 'fight' ? state.sequence : undefined;

const byId = (a: OperativeState, b: OperativeState): number => (a.id < b.id ? -1 : 1);

const horizontalGap = (a: Vec2, aBase: BaseShape, aRot: number, m: MarkerState): number =>
  baseGap(a, aBase, aRot, m.pos, { shape: 'round', mm: m.diameterMm }, 0);

// ---------------------------------------------------------------------------
// Drop Insertion › set up above
// ---------------------------------------------------------------------------

/** "Place them to one side instead of in the killzone" — off the floor, but still deployed. */
const parkingSpot = (index: number): Vec2 => ({ x: -22, y: -18 - index * 2.5 });

export const isAbove = (state: GameState, op: OperativeState): boolean =>
  state.effects.some((e) => e.rule === ABOVE && e.operativeId === op.id);

export const aboveOperatives = (state: GameState, player: PlayerId): OperativeState[] =>
  aliveOperatives(state, player).filter((o) => isAbove(state, o));

function goAbove(state: GameState, op: OperativeState): void {
  if (isAbove(state, op)) return;
  op.pos = parkingSpot(aboveOperatives(state, op.player).length);
  op.z = 0;
  op.onGuard = false;
  op.stickyEngagedWith = [];
  effect(state, {
    rule: ABOVE,
    source: { kind: 'ability', id: RULE.dropInsertion },
    sourceText: shortQuote(printed(RULE.dropInsertion)),
    operativeId: op.id,
    player: op.player,
    expiry: { kind: 'endOfBattle' },
  });
  log(state, {
    kind: 'system',
    player: op.player,
    text: `${op.letter} is set up above`,
    data: { operativeId: op.id },
  });
}

// ---------------------------------------------------------------------------
// Drop Insertion › your Drop markers
// ---------------------------------------------------------------------------

const MARKER_MM = 20;
const MARKER_R = 20 / 25.4 / 2;
/** Three thirds; the first is always set up as normal, so at most two Drop markers. */
export const MAX_DROP_MARKERS = 2;

export const dropMarkerId = (player: PlayerId, n: number): string => `tempestus-aquilons.drop.${player}.${n}`;

export function dropMarkers(state: GameState, player: PlayerId): MarkerState[] {
  const out: MarkerState[] = [];
  for (let n = 0; n < MAX_DROP_MARKERS; n++) {
    const m = state.markers[dropMarkerId(player, n)];
    if (m) out.push(m);
  }
  return out;
}

const zoneOf = (state: GameState, player: PlayerId): 'p1' | 'p2' => state.setup.dropZone[player] ?? player;
const dropZonePolys = (state: GameState, player: PlayerId): Poly[] =>
  state.map.dropZones[zoneOf(state, player)] ?? [];

/** "Wholly within your drop zone" for a 20mm marker. */
const markerInsideZone = (p: Vec2, zone: Poly[]): boolean =>
  baseWhollyWithin(p, { shape: 'round', mm: MARKER_MM }, 0, zone);

/**
 * "…then place one of your Drop markers wholly within your drop zone."
 *
 * There is no decision channel at deployment, so the position is a deterministic, logged default
 * (D-016): sample the drop zone on a half-inch grid, keep the spots where the whole marker is
 * inside it, and take the one nearest the opponent's drop zone — with the second marker pushed
 * at least 4" away from the first so the two mouths are not on top of each other.
 */
export function dropMarkerSpot(state: GameState, player: PlayerId, taken: Vec2[]): Vec2 | undefined {
  const zone = dropZonePolys(state, player);
  if (zone.length === 0) return undefined;
  let lo = { x: Infinity, y: Infinity };
  let hi = { x: -Infinity, y: -Infinity };
  for (const poly of zone)
    for (const p of poly) {
      lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y) };
      hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y) };
    }
  const foeZone = dropZonePolys(state, otherPlayer(player));
  let aim = { x: state.map.board.w / 2, y: state.map.board.h / 2 };
  if (foeZone.length > 0) {
    let n = 0;
    let sum = { x: 0, y: 0 };
    for (const poly of foeZone)
      for (const p of poly) {
        sum = { x: sum.x + p.x, y: sum.y + p.y };
        n++;
      }
    if (n > 0) aim = { x: sum.x / n, y: sum.y / n };
  }
  let best: Vec2 | undefined;
  let bestKey = Infinity;
  for (let x = lo.x; x <= hi.x + 1e-9; x += 0.5) {
    for (let y = lo.y; y <= hi.y + 1e-9; y += 0.5) {
      const p = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
      if (!markerInsideZone(p, zone)) continue;
      if (taken.some((t) => dist(t, p) < 4 - 1e-6)) continue;
      const key = dist(p, aim);
      if (key < bestKey) {
        bestKey = key;
        best = p;
      }
    }
  }
  return best;
}

function placeDropMarker(state: GameState, player: PlayerId, n: number): MarkerState | undefined {
  const pos = dropMarkerSpot(
    state,
    player,
    dropMarkers(state, player).map((m) => m.pos),
  );
  if (!pos) return undefined;
  const marker: MarkerState = {
    id: dropMarkerId(player, n),
    kind: 'generic',
    diameterMm: MARKER_MM,
    pos,
    z: 0,
    owner: player,
    flags: { drop: n },
  };
  state.markers[marker.id] = marker;
  log(state, {
    kind: 'system',
    player,
    text: `Drop marker ${n} placed at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
    data: { markerId: marker.id },
  });
  return marker;
}

/** The printed thirds of a kill team, in selection order. */
export function thirdsOf(state: GameState, player: PlayerId): OperativeState[][] {
  const team = state.teams[player].operativeIds
    .map((id) => state.operatives[id])
    .filter((o): o is OperativeState => Boolean(o) && !o!.removed);
  const size = Math.ceil(team.length / 3);
  const out: OperativeState[][] = [];
  for (let i = 0; i < team.length; i += size) out.push(team.slice(i, i + size));
  while (out.length > 3) {
    const tail = out.pop()!;
    out[out.length - 1] = [...out[out.length - 1]!, ...tail];
  }
  return out;
}

/**
 * "When setting up a TEMPESTUS AQUILON kill team before the battle, the first third of your kill
 * team must be set up as normal. Each third thereafter can be set up above… For each third
 * that's set up above, you must set up the whole third in this way (not some of them), then
 * place one of your Drop markers wholly within your drop zone."
 *
 * A pure setter (docs/DECISIONS.md D-017): the Set Up Operatives step has no decision channel,
 * and putting a third of the kill team into the sky silently would be worse than putting none
 * there. `thirds` is how many of the SECOND and THIRD thirds go above (the last third first, so
 * `thirds = 1` keeps the front two-thirds on the ground). Returns the ids actually set up above.
 */
export function setAbove(state: GameState, player: PlayerId, thirds: number): string[] {
  const blocks = thirdsOf(state, player);
  const want = Math.max(0, Math.min(MAX_DROP_MARKERS, Math.floor(thirds)));
  const done: string[] = [];
  // "Each third thereafter" — the first third can never go above.
  const chosen = blocks.slice(Math.max(1, blocks.length - want));
  for (const block of chosen) {
    // "you must set up the WHOLE third in this way (not some of them)"
    for (const op of block) {
      if (!isAquilon(op)) continue;
      goAbove(state, op);
      done.push(op.id);
    }
    const n = dropMarkers(state, player).length;
    if (n < MAX_DROP_MARKERS) placeDropMarker(state, player, n);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Drop Insertion › landing
// ---------------------------------------------------------------------------

/** "With no part of its base underneath Vantage terrain." */
export function underVantage(index: TerrainIndex, pos: Vec2, base: BaseShape, rot: number, z: number): boolean {
  const pts = [pos, ...basePerimeter(pos, base, rot, 16)];
  return index.parts.some(
    (p) => hasType(p, 'Vantage') && p.z1 > z + 0.05 && pts.some((q) => pointInPoly(q, p.poly)),
  );
}

/**
 * "Within 3" horizontally of one of your Drop markers" — 4" for a TROOPER (Swift Landing) and 5"
 * under the ADJUST COORDINATES firefight ploy, each "taking precedence over the normal distance
 * requirement", so the widest one that applies wins.
 */
export function landingRadius(state: GameState, op: OperativeState): number {
  let r = 3;
  if (op.datacardId === CARD.trooper) r = Math.max(r, 4);
  if (effectOn(state, op.id, ADJUSTED)) r = Math.max(r, 5);
  return r;
}

/**
 * Every printed landing requirement in one resolver, shared by `check` and `perform` so nothing
 * `check` accepts can be refused later (docs/DECISIONS.md D-026).
 */
export function landingSpot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  want?: Vec2,
): { ok: boolean; reason?: string; pos?: Vec2; z?: number } {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) return { ok: false, reason: 'unknown datacard' };
  const index = terrain(ctx, state);
  const radius = landingRadius(state, op);
  const markers = dropMarkers(state, op.player);
  const zone = dropZonePolys(state, op.player);

  const legal = (pos: Vec2): { ok: boolean; reason?: string; z?: number } => {
    // "Within 3" horizontally of one of your Drop markers, or wholly within your drop zone."
    const nearMarker = markers.some((m) => horizontalGap(pos, c.base, op.rot, m) <= radius + EPS);
    const inZone = zone.length > 0 && baseWhollyWithin(pos, c.base, op.rot, zone);
    if (!nearMarker && !inZone)
      return {
        ok: false,
        reason: `it must be set up within ${radius}" horizontally of one of your Drop markers, or wholly within your drop zone`,
      };
    const r = baseRadius(c.base);
    const { w, h } = state.map.board;
    if (pos.x - r < -EPS || pos.y - r < -EPS || pos.x + r > w + EPS || pos.y + r > h + EPS)
      return { ok: false, reason: 'bases cannot be over the edge of the killzone' };
    if (baseTouchesHazardous(index, pos, c.base, op.rot))
      return { ok: false, reason: 'a base cannot touch a hazardous area' };
    const z = surfaceAt(index, pos);
    if (baseBlockedByTerrain(index, pos, c.base, op.rot, z, modelHeight(c)))
      return { ok: false, reason: 'it must be set up in a location it can be placed' };
    // "With no part of its base underneath Vantage terrain."
    if (underVantage(index, pos, c.base, op.rot, z))
      return { ok: false, reason: 'no part of its base can be underneath Vantage terrain' };
    // Killzones § Stronghold H caps the highest upper level "at once", and its parenthesis
    // says "moving onto OR BEING SET UP ON" — so a drop honours it as a move would.
    if (occupancyCapExceeded(index, aliveOperatives(state), op.id, op.player, pos, z))
      return { ok: false, reason: 'only one friendly operative can be on that level at once' };
    for (const other of aliveOperatives(state)) {
      if (other.id === op.id || isAbove(state, other)) continue;
      const oc = ctx.datacards.get(other.datacardId);
      if (!oc) continue;
      if (basesOverlap(pos, c.base, op.rot, other.pos, oc.base, other.rot))
        return { ok: false, reason: 'a base cannot be placed on another' };
    }
    // "Not within control range of enemy operatives (unless you're setting up a PRECURSOR
    //  operative, which can be set up within control range of an enemy operative)."
    if (op.datacardId !== CARD.precursor) {
      const landed = { id: op.id, pos, z, rot: op.rot, base: c.base, height: modelHeight(c) };
      const engaged = aliveOperatives(state, otherPlayer(op.player)).some(
        (e) => !isAbove(state, e) && withinControlRange(index, landed, body(ctx, e)),
      );
      if (engaged) return { ok: false, reason: 'it cannot be set up within control range of an enemy operative' };
    }
    return { ok: true, z };
  };

  if (want) {
    const r = legal(want);
    return r.ok ? { ok: true, pos: want, z: r.z ?? 0 } : { ok: false, reason: r.reason ?? 'it cannot be placed there' };
  }
  // Deterministic default (D-016): rings around each Drop marker, newest first, then a scan of
  // the drop zone (which is the only branch available before any Drop marker exists).
  for (let i = markers.length - 1; i >= 0; i--) {
    const centre = markers[i]!.pos;
    for (const ring of [0, 0.8, 1.6, 2.4]) {
      for (let a = 0; a < 360; a += ring === 0 ? 360 : 30) {
        const rad = (a * Math.PI) / 180;
        const p = { x: centre.x + Math.cos(rad) * ring, y: centre.y + Math.sin(rad) * ring };
        const r = legal(p);
        if (r.ok) return { ok: true, pos: p, z: r.z ?? 0 };
      }
    }
  }
  if (zone.length > 0) {
    let lo = { x: Infinity, y: Infinity };
    let hi = { x: -Infinity, y: -Infinity };
    for (const poly of zone)
      for (const p of poly) {
        lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y) };
        hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y) };
      }
    for (let x = lo.x; x <= hi.x + 1e-9; x += 0.5) {
      for (let y = lo.y; y <= hi.y + 1e-9; y += 0.5) {
        const p = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
        const r = legal(p);
        if (r.ok) return { ok: true, pos: p, z: r.z ?? 0 };
      }
    }
  }
  return { ok: false, reason: 'there is no location it can be set up in' };
}

// ---------------------------------------------------------------------------
// Faction rules, datacard abilities and rare weapon rules
// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);

  // =========================================================================
  // Drop Insertion
  // =========================================================================
  // "In the Firefight phase, friendly TEMPESTUS AQUILON operatives set up above are activated as
  //  normal. When you do, you can either expend or land that operative." Landing is the LAND
  //  action below; expending is simply ending the activation, so nothing else is legal up there.
  reg.on('canPerformAction', T.bind(RULE.dropInsertion, 8), (ev) => {
    if (!mine(ev.operative) || !isAbove(ev.state, ev.operative)) return;
    if (ev.action === LAND) return;
    ev.allowed = false;
    ev.reason = 'it is set up above — you can either expend or land it';
  });
  // An operative that is not in the killzone cannot be shot at.
  reg.on('onValidTarget', T.bind(RULE.dropInsertion, 8), (ev) => {
    if (!mine(ev.target) || !isAbove(ev.state, ev.target)) return;
    ev.valid = false;
    ev.reason = 'that operative is set up above, not in the killzone';
  });

  // "As a STRATEGIC GAMBIT in the first and second turning point, you can move your Drop markers
  //  up to 4" horizontally. In a killzone that uses the close quarters rules (e.g. Killzone:
  //  Gallowdark), this can be measured and moved through Wall terrain." A straight horizontal
  //  line IS measured through Wall terrain, so that clause holds by construction.
  reg.on('gambitOptions', T.bind(RULE.dropInsertion, 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint > 2) return;
    if (dropMarkers(ev.state, T.player).length === 0) return;
    ev.options.push({
      id: DROP_MARKER_GAMBIT,
      label: 'Drop Insertion: move your Drop markers up to 4" (0CP)',
      sourceText: shortQuote(printed(RULE.dropInsertion)),
    });
  });
  reg.on('onPloyUsed', T.bind(RULE.dropInsertion, 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== DROP_MARKER_GAMBIT) return;
    const want = ev.data?.['pos'] as Vec2 | undefined;
    for (const marker of dropMarkers(ev.state, T.player)) {
      moveDropMarker(ev.state, T.player, marker, want && typeof want.x === 'number' ? want : undefined, 4);
    }
  });

  // "When readying your operatives during the second and third turning points, remove one of
  //  your Drop markers."
  reg.on('onReadyStep', T.bind(RULE.dropInsertion, 12), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.state.turningPoint !== 2 && ev.state.turningPoint !== 3) return;
    const markers = dropMarkers(ev.state, T.player);
    const last = markers[markers.length - 1];
    if (!last) return;
    delete ev.state.markers[last.id];
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Drop Insertion: ${last.id} is removed in the Ready step of turning point ${ev.state.turningPoint}`,
    });
  });

  // "This means operatives still set up above are incapacitated at the end of the second turning
  //  point." `endTurningPoint` runs `removeIncapacitated` BEFORE this emit, so the casualties are
  //  swept here or the end-of-turning-point scoring would still see them in play.
  reg.on('onEndOfTP', T.bind(RULE.dropInsertion, 12), (ev) => {
    if (ev.state.turningPoint !== 2) return;
    let any = false;
    for (const op of aboveOperatives(ev.state, T.player)) {
      if (op.incapacitated) continue;
      op.incapacitated = true;
      any = true;
      log(ev.state, {
        kind: 'action',
        player: T.player,
        text: `${op.letter} is still set up above at the end of the second turning point and is incapacitated`,
      });
    }
    if (any && T.ctx) removeIncapacitated(T.ctx, ev.state);
  });

  // REMINDER-ONLY: "Less than half of your operatives can be set up above by the end of the first
  // turning point." No hook refuses the end of an activation or compels an action, so the
  // violation is only detected and logged.
  reg.on('onEndOfTP', T.bind(RULE.dropInsertion, 13), (ev) => {
    if (ev.state.turningPoint !== 1) return;
    const team = aliveOperatives(ev.state, T.player);
    const above = aboveOperatives(ev.state, T.player).length;
    if (team.length === 0 || above * 2 < team.length) return;
    log(ev.state, {
      kind: 'system',
      player: T.player,
      text: `Drop Insertion: ${above} of ${team.length} operatives are still set up above — less than half are allowed by the end of the first turning point (not enforced)`,
      data: { reminderOnly: true },
    });
  });

  // "It's obscured until the end of the next activation or the end of the turning point
  //  (whichever comes first)." `nActivations: 2` is decremented at the end of the landing
  //  operative's own activation and again at the end of the next one; the turning-point half is
  //  the explicit sweep below, because expireEffects keeps an `nActivations` effect alive.
  reg.on('onCollectAttackDice', T.bind(RULE.dropInsertion, 14), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !mine(target)) return;
    if (!effectOn(ev.state, target.id, LANDED_OBSCURED)) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== target.id || seq.obscured) return;
    seq.obscured = true;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `${target.letter} has just landed — it is obscured`,
    });
  });
  reg.on('onEndOfTP', T.bind(RULE.dropInsertion, 14), (ev) => {
    dropEffects(ev.state, (e) => e.rule === LANDED_OBSCURED && e.player === T.player);
  });

  // =========================================================================
  // Grav-Chute — REMINDER-ONLY (see REMINDER_ONLY): onMoveRules is never emitted.
  // =========================================================================

  // =========================================================================
  // TEMPESTOR › Tempestus Veteran
  // =========================================================================
  // "Once per battle, you can either use a firefight ploy for 0CP if this is the specified
  //  TEMPESTUS AQUILON operative, or the Command Re-roll firefight ploy for 0CP if this is the
  //  operative the attack or defence dice was rolled for."
  //
  // CP is deducted before `onPloyUsed` fires, so the first half is a refund; the ploy's subject
  // is the operative each of this team's four firefight ploys resolved onto, recorded by their
  // own handlers (priority 20) and read back here at priority 60.
  const veteranKey = (): string => `tempestus-aquilons.veteran:${T.player}`;
  reg.on('onPloyUsed', T.bind(AB.veteran, 60), (ev) => {
    if (ev.player !== T.player || ev.kind !== 'firefight') return;
    const subject = String((bucket(ev.state, PLOY_SUBJECT) as Record<string, string>)[T.player] ?? '');
    const op = subject ? ev.state.operatives[subject] : undefined;
    if (!op || op.datacardId !== CARD.tempestor || op.player !== T.player) return;
    const cost = T.data.firefightPloys.find((p) => p.id === ev.ployId)?.cp ?? 0;
    if (cost <= 0) return;
    if (!useOncePerBattle(ev.state, veteranKey())) return;
    ev.state.teams[T.player].cp += cost;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Tempestus Veteran: ${op.letter} is the specified operative — that firefight ploy costs 0CP`,
    });
  });
  // "…or the Command Re-roll firefight ploy for 0CP if this is the operative the attack or
  //  defence dice was rolled for." Shoot-only: `fight.ts` emits no post-roll hook (D-031).
  const discountCommandReroll = (state: GameState, who: OperativeState | undefined, grants: RerollGrant[], pool: string): void => {
    if (!who || who.player !== T.player || who.datacardId !== CARD.tempestor) return;
    if (usedThisBattle(state, veteranKey())) return;
    const existing = grants.find((g) => g.id.startsWith('commandReroll'));
    if (!existing || (existing.cp ?? 0) === 0) return;
    if (!useOncePerSequence(state, `tempestus-aquilons.veteranReroll:${T.player}:${pool}`)) return;
    if (!useOncePerBattle(state, veteranKey())) return;
    existing.cp = 0;
    existing.label = 'Command Re-roll (0CP, Tempestus Veteran)';
    log(state, { kind: 'ploy', player: T.player, text: 'Tempestus Veteran: Command Re-roll for 0CP' });
  };
  reg.on('onRollAttack', T.bind(AB.veteran, 45), (ev) => {
    discountCommandReroll(ev.state, ev.ctx.attacker, ev.rerolls, 'attack');
  });
  reg.on('onDefenceDice', T.bind(AB.veteran, 45), (ev) => {
    if (ev.count > 0) return; // the reroll emit, not the Roll Defence Dice one
    discountCommandReroll(ev.state, ev.ctx.defender, ev.rerolls, 'defence');
  });

  // =========================================================================
  // GRENADIER › Grenadier
  // =========================================================================
  // "This operative can use frag, krak, smoke and stun grenades (see universal equipment)."
  // Frag and krak are WEAPONS, granted to the GRENADIER whether or not the kill team took the
  // equipment (the Brood Brother SAPPER shape); smoke and stun are universal ACTIONS gated on the
  // equipment, so the GRENADIER gets its own pair (registered below, the Hearthkyn shape).
  const armGrenadier = (state: GameState): void => {
    for (const o of T.friendlies(state).filter((x) => x.datacardId === CARD.grenadier)) {
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
  // The universal Explosive Grenades limiter runs at priority 10 on this hook; the GRENADIER is
  // exempt, so its grenade is re-allowed at a later priority.
  reg.on('onSelectWeapon', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== CARD.grenadier) return;
    if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName)) return;
    ev.allowed = true;
    delete ev.reason;
  });
  // "Doing so doesn't count towards any limited uses you have" — the equipment's spender runs at
  // priority 10 on this hook, so its increment is handed straight back.
  reg.on('onCollectAttackDice', T.bind(AB.grenadier, 40), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.attacker.datacardId !== CARD.grenadier) return;
    if (!GRENADE_WEAPON_NAMES.includes(ev.ctx.weaponName) || ev.ctx.secondary) return;
    const choice = /krak/i.test(ev.ctx.weaponName) ? 'krak' : 'frag';
    if (grenadeAllowance(ev.state, T.player, EXPLOSIVE_ID, choice) <= 0) return;
    const uses = ev.state.teams[T.player].equipmentUses;
    const key = `used:${EXPLOSIVE_ID}:${choice}`;
    uses[key] = Math.max(0, (uses[key] ?? 0) - 1);
  });
  // "Whenever this operative is using a frag or krak grenade, improve the Hit stat of that weapon
  //  by 1." `StatMods.hit` from `onCollectAttackDice` is dead — `hitOf` reads only `onStatMod`.
  reg.on('onStatMod', T.bind(AB.grenadier, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.grenadier) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.attackerId !== ev.operative.id) return;
    if (!GRENADE_WEAPON_NAMES.includes(seq.weaponName)) return;
    ev.mods.hit += 1;
  });

  // =========================================================================
  // GUNFIGHTER › Salvo (rare weapon rule, printed as a datacard ability)
  // =========================================================================
  // "Select up to two different valid targets that aren't within control range of friendly
  //  operatives. Shoot with this weapon against both of them in an order of your choice (roll
  //  each sequence separately)."
  //
  // The second target is queued in front of the (empty) secondary queue, exactly the Wrecka Krew
  // shape, so both are shot inside ONE Shoot action. The second target is the player's choice;
  // the lowest-id valid one is the deterministic default (D-016).
  reg.on('onCollectAttackDice', T.bind(AB.salvo, 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || !T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Salvo')) return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.secondary || seq.resolvedTargets.length > 0) return;
    const attacker = ev.ctx.attacker;
    const second = validTargetsFor(T, ev.state, attacker, seq.weaponName, seq.profileName)
      .filter((o) => o.id !== seq.targetId)
      // "…that aren't within control range of friendly operatives"
      .filter(
        (o) =>
          !T.friendlies(ev.state).some(
            (f) => f.id !== attacker.id && !isAbove(ev.state, f) && T.gap(f, o) <= 1 + EPS,
          ),
      )
      .sort(byId)[0];
    if (!second) return;
    seq.queue = [second.id, ...seq.queue];
    (bucket(ev.state, SALVO_SECOND) as Record<string, string>)[T.player] = second.id;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Salvo: ${attacker.letter} also shoots ${second.letter}`,
    });
  });
  // "…roll each sequence separately": the Salvo second target is a valid target in its own right,
  // not a Blast secondary, so its cover and obscured are re-determined before its dice are rolled.
  reg.on('onCollectAttackDice', T.bind(AB.salvo, 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player || !T.ctx) return;
    if (!ev.ctx.rules.some((r) => r.id === 'Salvo')) return;
    const seq = shootSeq(ev.state);
    if (!seq || !seq.secondary) return;
    if ((bucket(ev.state, SALVO_SECOND) as Record<string, string>)[T.player] !== seq.targetId) return;
    const target = ev.state.operatives[seq.targetId];
    if (!target) return;
    const check = checkTargetFor(T, ev.state, ev.ctx.attacker, target, ev.ctx.weaponName, seq.profileName);
    if (!check) return;
    // A tie between cover and obscured defaults to obscured (D-012).
    seq.obscured = check.obscured;
    seq.inCover = check.inCover && !(check.mustChoose && check.obscured);
  });

  // =========================================================================
  // GUNFIGHTER › Gunfight
  // =========================================================================
  // "Whenever an enemy operative within 8" of this operative shoots this operative, keep track of
  //  each attack dice that's discarded as a fail." The fails are final by the Roll Defence Dice
  //  step (re-rolls and retention are behind it), which is where they are counted.
  reg.on('onDefenceDice', T.bind(AB.gunfight, 12), (ev) => {
    if (ev.count <= 0 || ev.ctx.type !== 'ranged') return; // the Roll Defence Dice emit only
    const me = ev.ctx.defender;
    const shooter = ev.ctx.attacker;
    if (!me || me.player !== T.player || me.datacardId !== CARD.gunfighter) return;
    if (shooter.player === T.player || T.gap(shooter, me) > 8 + EPS) return;
    const seq = shootSeq(ev.state);
    if (!seq) return;
    const discarded = fails(seq.attack).length;
    dropEffects(ev.state, (e) => e.rule === GUNFIGHT_DEBT && e.operativeId === me.id);
    effect(ev.state, {
      rule: GUNFIGHT_DEBT,
      source: { kind: 'ability', id: AB.gunfight },
      sourceText: shortQuote(abilityText(CARD.gunfighter, AB.gunfight)),
      operativeId: me.id,
      player: T.player,
      // "…equal to the opponent's discarded attack dice plus one (to a maximum of four)"
      data: { targetId: shooter.id, dice: Math.min(4, discarded + 1) },
      expiry: { kind: 'endOfBattle' },
    });
  });
  // "After the action … this operative can perform a free Shoot action." Nothing runs at the end
  // of an action, so the grant is D-100's free AP — AP outside the APL budget — taken at the end
  // of the enemy activation and spent on the GUNFIGHTER's own next activation (see REMINDER_ONLY
  // for the timing loss). Only ever one at a time: the free Shoot spends the single GUNFIGHT_DEBT,
  // so a second pending grant would be an AP the GUNFIGHTER could never legally use.
  reg.on('onActivationEnd', T.bind(AB.gunfight, 20), (ev) => {
    if (ev.operative.player === T.player) return;
    for (const me of T.friendlies(ev.state).filter((o) => o.datacardId === CARD.gunfighter)) {
      const debt = effectOn(ev.state, me.id, GUNFIGHT_DEBT);
      if (!debt || debt.data?.['granted']) continue;
      debt.data = { ...(debt.data ?? {}), granted: true };
      // A second trigger refreshes the dice cap but must not bank a second AP: the shot spends
      // the one debt, so the extra AP could never legally be used.
      if (effectOn(ev.state, me.id, FREE_ACTION_RULE)) continue;
      grantFreeAction(ev.state, me, {
        sourceId: AB.gunfight,
        sourceText: shortQuote(abilityText(CARD.gunfighter, AB.gunfight)),
        kind: 'ability',
        threshold: currentApl(T, ev.state, me),
        only: [SHOOT_GUNFIGHT],
      });
    }
  });
  // "…you only roll a number of attack dice equal to the opponent's discarded attack dice plus
  //  one (to a maximum of four)."
  reg.on('onCollectAttackDice', T.bind(AB.gunfight, 12), (ev) => {
    if (ev.ctx.attacker.player !== T.player || ev.ctx.secondary) return;
    const shot = effectOn(ev.state, ev.ctx.attacker.id, GUNFIGHT_SHOT);
    if (!shot) return;
    ev.count = Number(shot.data?.['dice'] ?? ev.count);
  });

  // =========================================================================
  // MARKSMAN › Sniper's Vantage
  // =========================================================================
  // "Whenever this operative is on Vantage terrain and is shooting an operative that has an
  //  Engage order and is at least 2" lower than it, all profiles of its hot-shot long-las have
  //  the Severe weapon rule."
  reg.on('onWeaponRules', T.bind(AB.snipersVantage, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.marksman) return;
    if (ev.type !== 'ranged' || ev.retaliating || !T.ctx) return;
    if (!sameName(ev.weaponName, 'hot-shot long-las')) return;
    const target = ev.target;
    if (!target || target.order !== 'engage') return;
    if (ev.operative.z - target.z < 2 - EPS) return;
    if (!isOnVantage(terrain(T.ctx, ev.state), body(T.ctx, ev.operative))) return;
    if (ev.rules.some((r) => r.id === 'Severe')) return;
    ev.rules.push(ruleTag('Severe', undefined, "Severe (Sniper's Vantage)"));
  });

  // =========================================================================
  // MARKSMAN › Concealed Position (rare weapon rule)
  // =========================================================================
  // "This operative can only use this weapon the first time it's performing the Shoot action
  //  during the battle." Concealed Position sits on ONE profile of the long-las, which
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
  // PRECURSOR › Vicious Knife Fighter
  // =========================================================================
  // "Whenever this operative is fighting, after resolving your first attack dice during that
  //  sequence, you can immediately resolve another (before your opponent)."
  // `resolveFightDie` rewrites `seq.turn` AFTER `onStrikeResolved` is emitted, so the second dice
  // is resolved here directly (the Farstalker STEALTH ATTACK precedent). See REMINDER_ONLY: the
  // engine builds the strike/block options, so it is always taken as a strike.
  reg.on('onStrikeResolved', T.bind(AB.viciousKnifeFighter, 15), (ev) => {
    if (ev.ctx.type !== 'melee' || !T.ctx) return;
    const me = ev.ctx.attacker;
    if (me.player !== T.player || me.datacardId !== CARD.precursor) return;
    const seq = fightSeq(ev.state);
    if (!seq || seq.attackerId !== me.id) return; // "whenever this operative is FIGHTING"
    if (!useOncePerSequence(ev.state, `tempestus-aquilons.knife:${me.id}`)) return;
    const victim = ev.struck;
    if (victim.incapacitated || victim.removed) return;
    const die = successes(seq.attackerPool).find((d) => d.state === 'crit') ?? successes(seq.attackerPool)[0];
    if (!die) return;
    const crit = die.state === 'crit';
    die.state = 'struck';
    const dmg = crit ? ev.ctx.profile.dmgC : ev.ctx.profile.dmgN;
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Vicious Knife Fighter: ${me.letter} immediately resolves another dice for ${dmg}${crit ? ' (critical)' : ''}`,
    });
    inflictDamage(T.ctx, ev.state, victim, dmg, 'attack');
    const dev = devastatingDamage(ev.ctx.rules, crit ? 1 : 0);
    if (dev.perCrit > 0 && crit) inflictDamage(T.ctx, ev.state, victim, dev.perCrit, 'devastating');
  });

  // =========================================================================
  // PRECURSOR › Dynamic
  // =========================================================================
  // "Whenever this operative performs the Shoot or Fight action, it can immediately perform a
  //  free Dash action afterwards." D-100: one AP outside the APL budget, restricted to Dash —
  //  plus the `Dash (Dynamic)` carve-out, which is the only way to Dash after a Charge.
  reg.on('onCollectAttackDice', T.bind(AB.dynamic, 12), (ev) => {
    const me = ev.ctx.attacker;
    if (me.player !== T.player || me.datacardId !== CARD.precursor || ev.ctx.secondary) return;
    if (ev.state.activeOperativeId !== me.id) return;
    const seq = ev.state.sequence;
    if (seq?.kind === 'fight' && seq.attackerId !== me.id) return; // retaliating is not "performs"
    if (effectOn(ev.state, me.id, FREE_ACTION_RULE)) return;
    grantFreeAction(ev.state, me, {
      sourceId: AB.dynamic,
      sourceText: shortQuote(abilityText(CARD.precursor, AB.dynamic)),
      kind: 'ability',
      threshold: currentApl(T, ev.state, me),
      only: ['Dash', DASH_DYNAMIC],
    });
  });

  // =========================================================================
  // SERVO-SENTRY › Machine
  // =========================================================================
  // "This operative cannot perform any actions other than Dash, Fall Back, Reposition and Shoot."
  reg.on('canPerformAction', T.bind(AB.machine, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.servoSentry) return;
    const key = getAction(ev.action)?.treatedAs ?? ev.action;
    if (MACHINE_ACTIONS.includes(key)) return;
    ev.allowed = false;
    ev.reason = 'this operative cannot perform any actions other than Dash, Fall Back, Reposition and Shoot';
  });
  // "It cannot retaliate…" — `startFight` reads a core `cannotRetaliate` effect by that name.
  const ensureMachine = (state: GameState): void => {
    for (const op of T.friendlies(state)) {
      if (op.datacardId !== CARD.servoSentry) continue;
      if (effectOn(state, op.id, 'cannotRetaliate')) continue;
      effect(state, {
        rule: 'cannotRetaliate',
        source: { kind: 'ability', id: AB.machine },
        sourceText: shortQuote(abilityText(CARD.servoSentry, AB.machine)),
        operativeId: op.id,
        player: T.player,
        expiry: { kind: 'endOfBattle' },
      });
    }
  };
  reg.on('onDeploy', T.bind(AB.machine, 11), (ev) => {
    if (ev.operative.player === T.player) ensureMachine(ev.state);
  });
  reg.on('onActivationStart', T.bind(AB.machine, 11), (ev) => ensureMachine(ev.state));
  reg.on('onReadyStep', T.bind(AB.machine, 11), (ev) => {
    if (ev.player === T.player) ensureMachine(ev.state);
  });
  // "…or assist in a fight." `assistCount` does not say which enemy the fight is against, so an
  // assisting SERVO-SENTRY is recognised by replaying the same test against every enemy in the
  // fighter's control range (the Inquisitorial Agent TOME-SKULL shape).
  reg.on('onFightAssist', T.bind(AB.machine, 13), (ev) => {
    if (ev.operative.player !== T.player || ev.assists <= 0) return;
    const foes = T.enemies(ev.state).filter((e) => T.gap(ev.operative, e) <= 1 + EPS);
    for (const sentry of T.friendlies(ev.state)) {
      if (sentry.datacardId !== CARD.servoSentry || sentry.id === ev.operative.id) continue;
      const counted = foes.some(
        (foe) =>
          T.gap(sentry, foe) <= 1 + EPS && !T.enemies(ev.state).some((o) => o.id !== foe.id && T.gap(sentry, o) <= 1 + EPS),
      );
      if (counted) ev.assists = Math.max(0, ev.assists - 1);
    }
  });
  // "…or use any weapons that aren't on its datacard." `weaponsOf` appends `grantedWeapons` AFTER
  // the `availableWeapons` filter, so the ban is enforced where a granted weapon is actually
  // used: `availableWeapons` for the card's own list, `onSelectWeapon` for everything else.
  const cardWeapons = (op: OperativeState): string[] =>
    (catalogueCard(op.datacardId)?.weapons ?? []).map((w) => w.name.toLowerCase());
  reg.on('availableWeapons', T.bind(AB.machine, 12), (ev) => {
    if (ev.operative.player !== T.player || ev.operative.datacardId !== CARD.servoSentry) return;
    const own = cardWeapons(ev.operative);
    ev.weapons = ev.weapons.filter((n) => own.includes(n.toLowerCase()));
  });
  reg.on('onSelectWeapon', T.bind(AB.machine, 12), (ev) => {
    const op = ev.ctx.attacker;
    if (op.player !== T.player || op.datacardId !== CARD.servoSentry) return;
    if (cardWeapons(op).includes(ev.ctx.weaponName.toLowerCase())) return;
    ev.allowed = false;
    ev.reason = 'this operative cannot use any weapons that aren’t on its datacard';
  });

  // =========================================================================
  // SERVO-SENTRY › Turret — "can perform two Shoot actions during its activation."
  // =========================================================================
  // The second Shoot is `Shoot (Turret)` (D-021), registered below.

  // =========================================================================
  // TROOPER › Rapid Insertion — "STRATEGIC GAMBIT in the first turning point."
  // =========================================================================
  reg.on('gambitOptions', T.bindText(AB.rapidInsertion, abilityText(CARD.trooper, AB.rapidInsertion), 15), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint !== 1) return;
    if (!troopersInDropZone(T, ev.state).length) return;
    ev.options.push({
      id: RAPID_INSERTION_GAMBIT,
      label: 'Rapid Insertion (0CP)',
      sourceText: shortQuote(abilityText(CARD.trooper, AB.rapidInsertion)),
    });
  });
  reg.on('onPloyUsed', T.bindText(AB.rapidInsertion, abilityText(CARD.trooper, AB.rapidInsertion), 15), (ev) => {
    if (ev.player !== T.player || ev.ployId !== RAPID_INSERTION_GAMBIT) return;
    // "Each friendly TEMPESTUS AQUILON TROOPER operative wholly within your drop zone can
    //  immediately perform a free Reposition action, but must end that move wholly within 3" of
    //  your drop zone." The end-region requirement is enforced by the ActionDef below.
    for (const op of troopersInDropZone(T, ev.state)) {
      grantFreeAction(ev.state, op, {
        sourceId: AB.rapidInsertion,
        sourceText: shortQuote(abilityText(CARD.trooper, AB.rapidInsertion)),
        kind: 'ability',
        threshold: currentApl(T, ev.state, op),
        only: [REPOSITION_RAPID],
      });
    }
  });

  // =========================================================================
  // TROOPER › Swift Landing — read by `landingRadius`, inside the LAND action.
  // =========================================================================

  // A free action is spent inside the granted operative's own activation, and the engine drops
  // the grant when that activation ends (`expireActivationEffects`, D-100) — so nothing needs
  // undoing there. What the engine cannot close is a window that never opened: Gunfight grants
  // its free Shoot at the END of an enemy activation, and Rapid Insertion in the Gambit step, so
  // an operative that is already expended — or that is never activated again — carries a grant
  // with no activation left to spend it in. "…can immediately perform a free action" is an
  // immediate window, not a bankable one, so the Ready step of the next turning point clears
  // whatever was never taken.
  const dropUnspentGrant = (state: GameState, op: OperativeState): void => {
    for (const eff of effectsOn(state, op.id, FREE_ACTION_RULE)) {
      if (!FREE_ACTION_SOURCES.has(eff.source.id)) continue;
      dropEffects(state, (e) => e === eff);
    }
  };
  reg.on('onReadyStep', T.bind(RULE.dropInsertion, 90), (ev) => {
    if (ev.player !== T.player) return;
    for (const op of T.friendlies(ev.state)) dropUnspentGrant(ev.state, op);
  });

  // The per-activation ledger the HOT DROP ploy and Vantage drop test read.
  reg.on('onActivationStart', T.bind(RULE.dropInsertion, 4), (ev) => {
    if (ev.operative.player !== T.player || !T.ctx) return;
    dropEffects(ev.state, (e) => e.rule === ACTIVATION_MARK && e.operativeId === ev.operative.id);
    effect(ev.state, {
      rule: ACTIVATION_MARK,
      source: { kind: 'ability', id: RULE.dropInsertion },
      operativeId: ev.operative.id,
      player: T.player,
      data: {
        z: ev.operative.z,
        vantage: isAbove(ev.state, ev.operative)
          ? false
          : isOnVantage(terrain(T.ctx, ev.state), body(T.ctx, ev.operative)),
      },
      expiry: { kind: 'endOfActivation', operativeId: ev.operative.id },
    });
    // "…if they are the first friendly operatives activated this turning point equal to x."
    const ledger = bucket(ev.state, ACTIVATION_ORDINAL) as Record<string, number>;
    const key = `${T.player}:${ev.state.turningPoint}`;
    const n = (ledger[key] ?? 0) + 1;
    ledger[key] = n;
    ledger[`${ev.operative.id}:${ev.state.turningPoint}`] = n;
  });
}

// "…other than Dash, Fall Back, Reposition and Shoot" — plus Turret's second Shoot, which is its
// own ActionDef with its own restriction key (D-021) and so is not `treatedAs: 'Shoot'`.
const MACHINE_ACTIONS = ['Dash', 'Fall Back', 'Reposition', 'Shoot', SHOOT_TURRET];

/**
 * TEMPESTUS DAGGERS grants "the following melee weapon: Tempestus dagger", printed as a table the
 * scrape leaves as one column of lines (`NAME / ATK / HIT / DMG` then `Tempestus dagger / 3 / 4+ /
 * 3/4`). The stats are read out of it rather than copied into this file. Note this equipment
 * profile is NOT the PRECURSOR's own Tempestus dagger, which is 4 / 3+ / 3-4 with Ceaseless and
 * Lethal 5+ — the printed equipment table has no WR column at all.
 */
export const TEMPESTUS_DAGGER: Weapon = parseDagger();

function parseDagger(): Weapon {
  const lines = printed(EQ.tempestusDaggers)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const dmgHeader = lines.lastIndexOf('DMG');
  const cells = lines.slice(dmgHeader + 1);
  const [name, atk, hit, dmg] = cells;
  if (dmgHeader < 0 || !name || !atk || !hit || !dmg)
    throw new Error('TEMPESTUS DAGGERS weapon table is not in the printed shape');
  const [dmgN, dmgC] = dmg.split('/').map((n) => Number(n));
  return {
    name,
    profiles: [
      {
        type: 'melee',
        atk: Number(atk),
        hit: Number(hit.replace('+', '')),
        dmgN: dmgN ?? 0,
        dmgC: dmgC ?? 0,
        rules: [],
      },
    ],
  };
}

/** The rules of this team that hand out a free action, so an unspent grant can be closed out. */
const FREE_ACTION_SOURCES: ReadonlySet<string> = new Set<string>([AB.dynamic, AB.gunfight, AB.rapidInsertion]);

const sameName = (a: string | undefined, b: string): boolean =>
  (a ?? '').replace(/[‐-―]/g, '-').trim().toLowerCase() === b;

function hasShot(state: GameState, id: string): boolean {
  return Boolean((bucket(state, SHOT_ONCE) as Record<string, boolean>)[id]);
}
function markShot(state: GameState, id: string): void {
  (bucket(state, SHOT_ONCE) as Record<string, boolean>)[id] = true;
}

/** "Each friendly TEMPESTUS AQUILON TROOPER operative wholly within your drop zone." */
function troopersInDropZone(T: TeamHooks, state: GameState): OperativeState[] {
  const zone = dropZonePolys(state, T.player);
  if (zone.length === 0) return [];
  return T.friendlies(state, KW).filter(
    (o) => o.datacardId === CARD.trooper && !isAbove(state, o) && baseWhollyWithin(o.pos, baseOf(o), o.rot, zone),
  );
}

/** Valid targets, resolved through the core's own Select Valid Target step. */
function validTargetsFor(
  T: TeamHooks,
  state: GameState,
  attacker: OperativeState,
  weaponName: string,
  profileName: string | undefined,
): OperativeState[] {
  if (!T.ctx) return [];
  return validTargets(T.ctx, state, attacker, weaponName, profileName).map((r) => r.target);
}

function checkTargetFor(
  T: TeamHooks,
  state: GameState,
  attacker: OperativeState,
  target: OperativeState,
  weaponName: string,
  profileName: string | undefined,
): { inCover: boolean; obscured: boolean; mustChoose: boolean } | undefined {
  if (!T.ctx) return undefined;
  const w = weaponsOf(T.ctx, state, attacker, 'ranged').find((x: Weapon) => x.name === weaponName);
  if (!w) return undefined;
  const profile = findProfile(w, profileName);
  if (!profile) return undefined;
  const rules = effectiveRules(T.ctx, state, profile, { operative: attacker, target, weaponName });
  const check = checkTarget(T.ctx, state, attacker, target, profile, rules);
  return { inCover: check.inCover, obscured: check.obscured, mustChoose: check.mustChoose };
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  const mine = (op: OperativeState): boolean => T.mineKw(op, KW);
  const noteSubject = (state: GameState, op: OperativeState | undefined): void => {
    (bucket(state, PLOY_SUBJECT) as Record<string, string>)[T.player] = op?.id ?? '';
  };

  // =========================================================================
  // SUDDEN OFFENSIVE (strategy)
  // =========================================================================
  // "Count the number of friendly TEMPESTUS AQUILON operatives that aren't incapacitated, then
  //  halve the result (rounding up) to give you x. Until the end of their activation, friendly
  //  TEMPESTUS AQUILON operatives' weapons have the Balanced weapon rule if they are the first
  //  friendly operatives activated this turning point equal to x."
  reg.on('onPloyUsed', T.bind(SP.suddenOffensive, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.suddenOffensive) return;
    const n = T.friendlies(ev.state, KW).filter((o) => !o.incapacitated).length;
    effect(ev.state, {
      rule: SUDDEN,
      source: { kind: 'ploy', id: SP.suddenOffensive },
      sourceText: shortQuote(printed(SP.suddenOffensive)),
      player: T.player,
      data: { x: Math.ceil(n / 2) },
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('onWeaponRules', T.bind(SP.suddenOffensive, 20), (ev) => {
    if (!mine(ev.operative)) return;
    const eff = ev.state.effects.find((e) => e.rule === SUDDEN && e.player === T.player);
    if (!eff) return;
    const ordinal = (bucket(ev.state, ACTIVATION_ORDINAL) as Record<string, number>)[
      `${ev.operative.id}:${ev.state.turningPoint}`
    ];
    if (!ordinal || ordinal > Number(eff.data?.['x'] ?? 0)) return;
    // "Until the end of their activation" — only while that operative is the active one.
    if (ev.state.activeOperativeId !== ev.operative.id) return;
    if (ev.rules.some((r) => r.id === 'Balanced')) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (SUDDEN OFFENSIVE)'));
  });

  // =========================================================================
  // MAINTAIN MOMENTUM (strategy)
  // =========================================================================
  // "Whenever a friendly TEMPESTUS AQUILON operative is shooting against or fighting against a
  //  ready enemy operative, that friendly operative's weapons have the Severe weapon rule."
  // `onWeaponRules` is read by BOTH sequences, so shooting and fighting are both live;
  // `retaliating` is excluded because the printed rule names neither.
  reg.on('onWeaponRules', T.bind(SP.maintainMomentum, 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, SP.maintainMomentum)) return;
    if (!mine(ev.operative) || ev.retaliating) return;
    const foe = ev.target;
    if (!foe || foe.player === T.player || !foe.ready) return;
    if (ev.rules.some((r) => r.id === 'Severe')) return;
    ev.rules.push(ruleTag('Severe', undefined, 'Severe (MAINTAIN MOMENTUM)'));
  });

  // =========================================================================
  // EYE ABOVE (strategy)
  // =========================================================================
  // "Select one enemy operative. That operative and each other enemy operative within 3" of it
  //  gains one of your Detected tokens until the end of the turning point."
  reg.on('onPloyUsed', T.bind(SP.eyeAbove, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.eyeAbove) return;
    const foes = T.enemies(ev.state).filter((o) => !o.incapacitated).sort(byId);
    const chosen = chosenOperative(ev.state, ev.data, foes);
    if (!chosen) return;
    for (const foe of foes) {
      if (foe.id !== chosen.id && T.gap(chosen, foe) > 3 + EPS) continue;
      effect(ev.state, {
        rule: DETECTED_TOKEN,
        source: { kind: 'ploy', id: SP.eyeAbove },
        sourceText: shortQuote(printed(SP.eyeAbove)),
        operativeId: foe.id,
        player: T.player,
        expiry: { kind: 'endOfTurningPoint' },
      });
    }
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `EYE ABOVE: ${chosen.letter} and each enemy operative within 3" of it gain a Detected token`,
    });
  });
  // "Is shooting a friendly TEMPESTUS AQUILON operative, you can re-roll one of your defence dice."
  reg.on('onDefenceDice', T.bind(SP.eyeAbove, 21), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !mine(target) || ev.ctx.type !== 'ranged') return;
    if (!detected(ev.state, T.player, ev.ctx.attacker.id)) return;
    ev.rerolls.push({
      id: 'tempestus-aquilons.eyeAbove.defence',
      label: 'EYE ABOVE: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(printed(SP.eyeAbove)),
    });
  });
  // "Is fighting or retaliating against a friendly TEMPESTUS AQUILON operative, ONE of your blocks
  //  can be allocated to block two unresolved successes (instead of one)."
  reg.on('onBlockAllocation', T.bind(SP.eyeAbove, 21), (ev) => {
    const blocker = ev.ctx.attacker; // the side resolving the die
    const foe = ev.ctx.defender;
    if (blocker.player !== T.player || !mine(blocker) || !foe) return;
    if (!detected(ev.state, T.player, foe.id)) return;
    if (!useOncePerSequence(ev.state, `tempestus-aquilons.eyeAbove:${blocker.id}`)) return;
    ev.blocks = Math.max(ev.blocks, 2);
  });

  // =========================================================================
  // DROP AND SECURE (strategy)
  // =========================================================================
  // "Select one marker. Until the Ready step of the next Strategy phase, when determining control
  //  of that marker, treat the total APL stat of friendly TEMPESTUS AQUILON operatives that
  //  contest it as 1 higher if at least one friendly TEMPESTUS AQUILON operative contests that
  //  marker… Whenever a friendly TEMPESTUS AQUILON operative is within 3" of that marker, add 1
  //  to the Atk stat of its melee weapons (to a maximum of 4)."
  reg.on('onPloyUsed', T.bindText(SP.dropAndSecure, printed(SP.dropAndSecure), 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== SP.dropAndSecure) return;
    const wanted = ev.data?.['markerId'];
    const markers = Object.values(ev.state.markers).sort((a, b) => (a.id < b.id ? -1 : 1));
    const chosen =
      (typeof wanted === 'string' ? markers.find((m) => m.id === wanted) : undefined) ??
      // D-016: the deterministic default is the objective marker nearest this team's centroid.
      markers.filter((m) => m.kind === 'objective').sort(byNearest(T, ev.state))[0] ??
      markers[0];
    if (!chosen) return;
    effect(ev.state, {
      rule: DROP_SECURE,
      source: { kind: 'ploy', id: SP.dropAndSecure },
      sourceText: shortQuote(printed(SP.dropAndSecure)),
      player: T.player,
      data: { markerId: chosen.id },
      // "Until the Ready step of the NEXT Strategy phase" — which is LATER than the end of
      // the turning point, so `endOfTurningPoint` would drop it too early on its own terms.
      // The `onReadyStep` handler below is what actually ends it.
      // (It was also written this way because `expireEffects` used to run before
      // `scoreEndOfTurningPoint`; that ordering is fixed in the core now — D-091.)
      expiry: { kind: 'endOfBattle' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `DROP AND SECURE: ${chosen.id}` });
  });
  reg.on('onReadyStep', T.bindText(SP.dropAndSecure, printed(SP.dropAndSecure), 20), (ev) => {
    if (ev.player !== T.player) return;
    dropEffects(ev.state, (e) => e.rule === DROP_SECURE && e.player === T.player);
  });
  reg.on('onMarkerControl', T.bindText(SP.dropAndSecure, printed(SP.dropAndSecure), 20), (ev) => {
    if (!T.ctx) return;
    const eff = ev.state.effects.find((e) => e.rule === DROP_SECURE && e.player === T.player);
    if (!eff || eff.data?.['markerId'] !== ev.markerId) return;
    const marker = ev.state.markers[ev.markerId];
    if (!marker) return;
    if (!T.friendlies(ev.state, KW).some((o) => markerContestedBy(T.ctx!, ev.state, marker, o))) return;
    ev.aplByPlayer[T.player] = ev.aplByPlayer[T.player] + 1;
  });
  reg.on('onCollectAttackDice', T.bindText(SP.dropAndSecure, printed(SP.dropAndSecure), 20), (ev) => {
    if (ev.ctx.type !== 'melee' || !mine(ev.ctx.attacker)) return;
    const eff = ev.state.effects.find((e) => e.rule === DROP_SECURE && e.player === T.player);
    if (!eff) return;
    const marker = ev.state.markers[String(eff.data?.['markerId'] ?? '')];
    if (!marker) return;
    if (T.markerGap(ev.ctx.attacker, marker) > 3 + EPS) return;
    // "…add 1 to the Atk stat of its melee weapons (to a maximum of 4)."
    if (ev.count >= 4) return;
    ev.count = Math.min(4, ev.count + 1);
  });

  // =========================================================================
  // HOT DROP (firefight)
  // =========================================================================
  // "Use this firefight ploy after rolling your attack dice for a friendly TEMPESTUS AQUILON
  //  operative that's wholly within your opponent's territory, or either landed or dropped from
  //  Vantage terrain at least 2" higher than the killzone floor during this activation. If the
  //  target is within 6" of it, you can re-roll any of your attack dice."
  // `onRollAttack` is emitted by shoot.ts ONLY (D-031) — see REMINDER_ONLY for the fight half.
  reg.on('onPloyUsed', T.bind(FP.hotDrop, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.hotDrop) return;
    const seq = shootSeq(ev.state);
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    noteSubject(ev.state, seq ? ev.state.operatives[seq.attackerId] : active);
    // "…for a friendly operative" — one attack roll, so the grant is armed rather than read back
    // from `ploysUsedTP`, and disarmed at the end of that operative's activation.
    (bucket(ev.state, HOT_DROP_ARMED) as Record<string, boolean>)[T.player] = true;
  });
  reg.on('onActivationEnd', T.bind(FP.hotDrop, 22), (ev) => {
    if (ev.operative.player !== T.player) return;
    delete (bucket(ev.state, HOT_DROP_ARMED) as Record<string, boolean>)[T.player];
  });
  reg.on('onRollAttack', T.bind(FP.hotDrop, 20), (ev) => {
    if (!(bucket(ev.state, HOT_DROP_ARMED) as Record<string, boolean>)[T.player]) return;
    if (!ployUsed(ev.state, T.player, FP.hotDrop)) return;
    const me = ev.ctx.attacker;
    if (!mine(me) || !hotDropReady(ev.state, T.player, me)) return;
    const foe = ev.ctx.defender;
    if (!foe || T.gap(me, foe) > 6 + EPS) return;
    if (ev.rerolls.some((g) => g.id === 'tempestus-aquilons.hotDrop')) return;
    ev.rerolls.push({
      id: 'tempestus-aquilons.hotDrop',
      label: 'HOT DROP: re-roll any of your attack dice',
      mode: 'any',
      player: T.player,
      sourceText: shortQuote(printed(FP.hotDrop)),
    });
  });

  // =========================================================================
  // ADJUST COORDINATES (firefight)
  // =========================================================================
  // "Use this firefight ploy when a friendly TEMPESTUS AQUILON operative lands. You can set it up
  //  within 5" horizontally of one of your Drop markers, taking precedence over the normal
  //  distance requirement. It cannot perform the Dash, Shoot or Fight actions during this
  //  turning point."
  reg.on('onPloyUsed', T.bind(FP.adjustCoordinates, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.adjustCoordinates) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const candidates = aboveOperatives(ev.state, T.player);
    const op = active && mine(active) && isAbove(ev.state, active) ? active : chosenOperative(ev.state, ev.data, candidates);
    noteSubject(ev.state, op);
    if (!op) return;
    effect(ev.state, {
      rule: ADJUSTED,
      source: { kind: 'ploy', id: FP.adjustCoordinates },
      sourceText: shortQuote(printed(FP.adjustCoordinates)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
  });
  reg.on('canPerformAction', T.bind(FP.adjustCoordinates, 20), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, ADJUSTED)) return;
    // Turret's second Shoot carries its own restriction key (D-021), so it is named here too.
    const key = ev.action === SHOOT_TURRET ? 'Shoot' : getAction(ev.action)?.treatedAs ?? ev.action;
    if (key !== 'Dash' && key !== 'Shoot' && key !== 'Fight') return;
    ev.allowed = false;
    ev.reason = 'ADJUST COORDINATES: it cannot perform the Dash, Shoot or Fight actions during this turning point';
  });

  // =========================================================================
  // TEMPESTUS EXEMPLARS (firefight)
  // =========================================================================
  // "Use this firefight ploy during a friendly TEMPESTUS AQUILON operative's activation
  //  (excluding SERVO-SENTRY and any operative that has an APL stat higher than 2). During that
  //  activation, that operative can perform the Pick Up Marker, Place Marker or a mission action
  //  for 1 less AP"
  reg.on('onPloyUsed', T.bind(FP.tempestusExemplars, 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.tempestusExemplars) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op = active && exemplarEligible(T, ev.state, active) ? active : undefined;
    noteSubject(ev.state, op);
    if (!op) return;
    effect(ev.state, {
      rule: EXEMPLARS,
      source: { kind: 'ploy', id: FP.tempestusExemplars },
      sourceText: shortQuote(printed(FP.tempestusExemplars)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
  });
  reg.on('onActionCost', T.bind(FP.tempestusExemplars, 20), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, EXEMPLARS)) return;
    const def = getAction(ev.action);
    const key = def?.treatedAs ?? ev.action;
    if (key !== 'Pick Up Marker' && key !== 'Place Marker' && def?.type !== 'mission') return;
    ev.ap = Math.max(0, ev.ap - 1);
  });

  // =========================================================================
  // PROGENA (firefight)
  // =========================================================================
  // "Use this firefight ploy when a friendly TEMPESTUS AQUILON operative (excluding SERVO-SENTRY)
  //  is activated. It regains up to 2D3 lost wounds, and during that activation you can ignore
  //  any changes to its APL stat."
  reg.on('onPloyUsed', T.bindText(FP.progena, printed(FP.progena), 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== FP.progena || !T.ctx) return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const op =
      active && mine(active) && active.datacardId !== CARD.servoSentry
        ? active
        : chosenOperative(
            ev.state,
            ev.data,
            T.friendlies(ev.state, KW).filter((o) => o.datacardId !== CARD.servoSentry),
          );
    noteSubject(ev.state, op);
    if (!op) return;
    const dice = [T.ctx.rng.d3(), T.ctx.rng.d3()];
    recordRoll(ev.state, 'progena', dice, T.player, 'PROGENA 2D3');
    const max = T.card(op)?.wounds ?? op.wounds;
    const healed = Math.min(dice[0]! + dice[1]!, Math.max(0, max - op.wounds));
    op.wounds += healed;
    // "…you can ignore any changes to its APL stat" — see the `onStatMod` handler below.
    effect(ev.state, {
      rule: PROGENA_APL,
      source: { kind: 'ploy', id: FP.progena },
      sourceText: shortQuote(printed(FP.progena)),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `PROGENA: ${op.letter} regains ${healed} wounds` });
  });
  // "…you can ignore any changes to its APL stat." `aplOf` computes
  // `raw = sum(op.aplMods) + statMods().apl`, so cancelling BOTH is one assignment made at the
  // last priority — after every other `onStatMod` handler has had its say. Purely: `onStatMod` is
  // emitted from `aplOf`/`moveOf`/`hitOf`, which the AI reads many times per turn, so this must
  // never mutate the operative (the Kommandos SHAKE IT OFF clear-aplMods shape would).
  reg.on('onStatMod', T.bindText(FP.progena, printed(FP.progena), 95), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, PROGENA_APL)) return;
    ev.mods.apl = -ev.operative.aplMods.reduce((a, b) => a + b, 0);
  });
}

const detected = (state: GameState, player: PlayerId, operativeId: string): boolean =>
  state.effects.some((e) => e.rule === DETECTED_TOKEN && e.operativeId === operativeId && e.player === player);

const byNearest =
  (T: TeamHooks, state: GameState) =>
  (a: MarkerState, b: MarkerState): number => {
    const mine = T.friendlies(state, KW);
    const d = (m: MarkerState): number =>
      mine.length === 0 ? 0 : Math.min(...mine.map((o) => T.markerGap(o, m)));
    const da = d(a);
    const db = d(b);
    return da === db ? (a.id < b.id ? -1 : 1) : da - db;
  };

/** "…excluding SERVO-SENTRY and any operative that has an APL stat higher than 2." */
function exemplarEligible(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  if (!T.mineKw(op, KW) || op.datacardId === CARD.servoSentry) return false;
  return (T.card(op)?.apl ?? 2) <= 2;
}

/**
 * "…wholly within your opponent's territory, or either landed or dropped from Vantage terrain at
 * least 2" higher than the killzone floor during this activation."
 *
 * The drop half is detected as an elevation change across the activation from a Vantage position
 * at least 2" up (the Scout Squad Grapnel Assault precedent) — `validateMove` reports no legs.
 */
export function hotDropReady(state: GameState, player: PlayerId, op: OperativeState): boolean {
  const foeTerritory = state.map.territories[zoneOf(state, otherPlayer(player))] ?? [];
  if (foeTerritory.length > 0 && baseWhollyWithin(op.pos, baseOf(op), op.rot, foeTerritory)) return true;
  if (effectOn(state, op.id, LANDED)) return true;
  const mark = effectOn(state, op.id, ACTIVATION_MARK);
  if (!mark) return false;
  const from = Number(mark.data?.['z'] ?? 0);
  return Boolean(mark.data?.['vantage']) && from >= 2 - EPS && op.z < from - EPS;
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // TEMPESTUS DAGGERS — "Friendly TEMPESTUS AQUILON operatives (excluding SERVO-SENTRY) have the
  // following melee weapon: Tempestus dagger". The profile is read from the printed table in the
  // equipment entry, never retyped.
  const dagger = TEMPESTUS_DAGGER;
  const armDaggers = (state: GameState): void => {
    for (const op of T.friendlies(state, KW)) {
      if (op.datacardId === CARD.servoSentry) continue;
      grantWeapon(op, structuredClone(dagger));
    }
  };
  reg.on('onDeploy', T.bind(EQ.tempestusDaggers, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.tempestusDaggers)) return;
    if (ev.operative.player === T.player) armDaggers(ev.state);
  });
  reg.on('onActivationStart', T.bind(EQ.tempestusDaggers, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.tempestusDaggers)) return;
    armDaggers(ev.state);
  });
  reg.on('onReadyStep', T.bind(EQ.tempestusDaggers, 30), (ev) => {
    if (ev.player !== T.player || !hasEquipment(ev.state, T.player, EQ.tempestusDaggers)) return;
    armDaggers(ev.state);
  });

  // COMBAT STIMMS — "You can ignore any changes to the Move stat of friendly TEMPESTUS AQUILON
  // operatives from being injured." `moveOf` subtracts 2" for injured after adding `mods.move`.
  reg.on('onStatMod', T.bind(EQ.combatStimms, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.combatStimms)) return;
    if (!T.mineKw(ev.operative, KW) || !T.ctx) return;
    const startWounds = T.card(ev.operative)?.wounds ?? ev.operative.wounds;
    if (ev.operative.wounds >= startWounds / 2) return;
    ev.mods.move += 2;
  });

  // DROP AUGURY — "Once per battle, when a friendly TEMPESTUS AQUILON operative that's set up
  // above is activated, before expending or landing that operative, you can move one of your Drop
  // markers again. However, it cannot be moved closer to your opponent's drop zone."
  reg.on('onActivationStart', T.bind(EQ.dropAugury, 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, EQ.dropAugury)) return;
    if (ev.operative.player !== T.player || !isAbove(ev.state, ev.operative)) return;
    const markers = dropMarkers(ev.state, T.player);
    const marker = markers[markers.length - 1];
    if (!marker) return;
    if (!useOncePerBattle(ev.state, `tempestus-aquilons.dropAugury:${T.player}`)) return;
    moveDropMarker(ev.state, T.player, marker, undefined, 4, true);
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `DROP AUGURY: ${marker.id} is moved again`,
      data: { markerId: marker.id },
    });
  });

  // REMOTE OVERSEER is REMINDER-ONLY — `initiativeRollModifiers` is emitted before the D6 and
  // `rollInitiative` never consults `rerollOffered`, so an initiative re-roll has no expression.
}

/**
 * "…you can move your Drop markers up to 4" horizontally." The destination is the player's
 * choice; with none supplied it heads for the opponent's drop zone (D-016), and DROP AUGURY's
 * `awayOnly` flag enforces its own "it cannot be moved closer to your opponent's drop zone" by
 * heading the other way instead.
 */
export function moveDropMarker(
  state: GameState,
  player: PlayerId,
  marker: MarkerState,
  want: Vec2 | undefined,
  inches: number,
  awayOnly = false,
): void {
  const { w, h } = state.map.board;
  const clamp = (p: Vec2): Vec2 => ({
    x: Math.min(Math.max(p.x, MARKER_R), w - MARKER_R),
    y: Math.min(Math.max(p.y, MARKER_R), h - MARKER_R),
  });
  const foeZone = state.map.dropZones[zoneOf(state, otherPlayer(player))] ?? [];
  const toFoe = (p: Vec2): number =>
    foeZone.length === 0 ? 0 : Math.min(...foeZone.map((poly) => distancePointToPoly(p, poly)));
  let aim: Vec2;
  if (want && typeof want.x === 'number') {
    aim = want;
  } else {
    let centre = { x: w / 2, y: h / 2 };
    if (foeZone.length > 0) {
      let n = 0;
      let sum = { x: 0, y: 0 };
      for (const poly of foeZone)
        for (const p of poly) {
          sum = { x: sum.x + p.x, y: sum.y + p.y };
          n++;
        }
      if (n > 0) centre = { x: sum.x / n, y: sum.y / n };
    }
    aim = awayOnly
      ? { x: marker.pos.x - (centre.x - marker.pos.x), y: marker.pos.y - (centre.y - marker.pos.y) }
      : centre;
  }
  const dx = aim.x - marker.pos.x;
  const dy = aim.y - marker.pos.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  const step = Math.min(inches, len);
  const to = clamp({ x: marker.pos.x + (dx / len) * step, y: marker.pos.y + (dy / len) * step });
  if (dist(marker.pos, to) > inches + EPS) return;
  // "However, it cannot be moved closer to your opponent's drop zone."
  if (awayOnly && toFoe(to) < toFoe(marker.pos) - EPS) return;
  marker.pos = to;
  log(state, {
    kind: 'ploy',
    player,
    text: `${marker.id} moves to (${to.x.toFixed(1)}, ${to.y.toFixed(1)})`,
    data: { markerId: marker.id },
  });
}

// ---------------------------------------------------------------------------
// Unique actions (docs/DECISIONS.md D-026: the whole legality lives in `check`)
// ---------------------------------------------------------------------------

/** COMMAND: "…one other friendly TEMPESTUS AQUILON operative (excluding SERVO-SENTRY) visible to
 *  and within 6" of this operative." */
export function commandTargets(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  const index = terrain(ctx, state);
  const inches = ctx.hooks.emit('onSupportDistance', state, { state, operative: op, inches: 6 }).inches;
  return aliveOperatives(state, op.player)
    .filter((o) => o.id !== op.id && !o.incapacitated && !isAbove(state, o))
    .filter((o) => isAquilon(o) && o.datacardId !== CARD.servoSentry)
    .filter((o) => baseGap(op.pos, baseOf(op), op.rot, o.pos, baseOf(o), o.rot) <= inches + EPS)
    .filter((o) => isVisible(index, body(ctx, op), body(ctx, o)).visible)
    .sort(byId);
}

function actions(data: TeamData): ActionDef[] {
  return [
    // COMMAND 1AP — TEMPESTOR (SUPPORT)
    uniqueAction(data, CARD.tempestor, ACT.command, {
      check: (ctx, state, op, params) => {
        // "This operative cannot perform this action while within control range of an enemy
        //  operative."
        const index = terrain(ctx, state);
        if (
          aliveOperatives(state, otherPlayer(op.player)).some(
            (e) => !isAbove(state, e) && withinControlRange(index, body(ctx, op), body(ctx, e)),
          )
        )
          return { ok: false, reason: 'within control range of an enemy operative' };
        const options = commandTargets(ctx, state, op);
        if (options.length === 0)
          return { ok: false, reason: 'no other friendly TEMPESTUS AQUILON operative is visible to and within 6"' };
        const wanted = params.targetOperativeId;
        if (wanted && !options.some((o) => o.id === wanted))
          return { ok: false, reason: 'that operative cannot be selected' };
        return { ok: true };
      },
      perform: (ctx, state, op, params) => {
        const options = commandTargets(ctx, state, op);
        const target = options.find((o) => o.id === params.targetOperativeId) ?? options[0]!;
        // "Until the end of that operative's next activation, add 1 to its APL stat."
        target.aplMods.push(1);
        effect(state, {
          rule: 'tempestus-aquilons.command',
          source: { kind: 'ability', id: ACT.command },
          sourceText: shortQuote(actionText(CARD.tempestor, ACT.command)),
          operativeId: target.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
        });
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.letter}: COMMAND — ${target.letter} gains 1 APL until the end of its next activation`,
          data: { operativeId: op.id, targetId: target.id },
        });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// LAND — printed inside the Drop Insertion faction rule, not on a datacard
// ---------------------------------------------------------------------------

registerAction({
  id: LAND,
  name: 'Land',
  ap: 1,
  type: 'unique',
  // "The operative is treated as performing the Reposition action (spend the AP accordingly)."
  treatedAs: 'Reposition',
  sourceText: printed(RULE.dropInsertion),
  available: (ctx, state, op) =>
    (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW) && isAbove(state, op),
  check(ctx, state, op, params) {
    if (!isAbove(state, op)) return { ok: false, reason: 'this operative is not set up above' };
    const spot = landingSpot(ctx, state, op, params.targetPos);
    return spot.ok ? { ok: true } : { ok: false, reason: spot.reason ?? 'it cannot be set up there' };
  },
  perform(ctx, state, op, params) {
    const spot = landingSpot(ctx, state, op, params.targetPos);
    if (!spot.ok || !spot.pos) return { ok: false, reason: spot.reason ?? 'it cannot be set up there' };
    dropEffects(state, (e) => e.rule === ABOVE && e.operativeId === op.id);
    op.pos = { ...spot.pos };
    op.z = spot.z ?? 0;
    // "With an order of your choice."
    if (params.choice === 'engage' || params.choice === 'conceal') op.order = params.choice;
    effect(state, {
      rule: LANDED,
      source: { kind: 'ability', id: RULE.dropInsertion },
      sourceText: shortQuote(printed(RULE.dropInsertion)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    // "It's obscured until the end of the next activation or the end of the turning point."
    effect(state, {
      rule: LANDED_OBSCURED,
      source: { kind: 'ability', id: RULE.dropInsertion },
      sourceText: shortQuote(printed(RULE.dropInsertion)),
      operativeId: op.id,
      player: op.player,
      expiry: { kind: 'nActivations', remaining: 2 },
    });
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter} lands at (${spot.pos.x.toFixed(1)}, ${spot.pos.y.toFixed(1)}) with a ${op.order} order`,
      data: { operativeId: op.id, action: LAND },
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Turret, Gunfight, Dynamic and Rapid Insertion: actions the universal ones forbid (D-021)
// ---------------------------------------------------------------------------

const TURRET_TEXT = abilityText(CARD.servoSentry, AB.turret);

/** The first ranged weapon this operative carries, so the AI's param probe can reach the action. */
function defaultShot(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  params: { weaponName?: string; profileName?: string; targetId?: string; targetOperativeId?: string },
): { weaponName?: string; profileName?: string; targetId?: string } {
  const weapons = weaponsOf(ctx, state, op, 'ranged');
  const weaponName = params.weaponName ?? weapons[0]?.name;
  const targetId = params.targetId ?? params.targetOperativeId;
  return {
    ...(weaponName ? { weaponName } : {}),
    ...(params.profileName ? { profileName: params.profileName } : {}),
    ...(targetId ? { targetId } : {}),
  };
}

/**
 * The Select Valid Target step, run inside `check`. The universal Shoot action's own check stops
 * at the weapon, so a friendly or screened target only fails inside `startShoot` — which is a
 * rejected intent the caller could not have predicted (D-026).
 */
function targetIsValid(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  weaponName: string | undefined,
  profileName: string | undefined,
  targetId: string | undefined,
): { ok: boolean; reason?: string } {
  const target = targetId ? state.operatives[targetId] : undefined;
  if (!weaponName || !target || target.removed) return { ok: false, reason: 'select a weapon and a valid target' };
  const w = weaponsOf(ctx, state, op, 'ranged').find((x) => x.name === weaponName);
  const profile = w ? findProfile(w, profileName) : undefined;
  if (!w || !profile) return { ok: false, reason: `no ranged weapon '${weaponName}'` };
  const rules = effectiveRules(ctx, state, profile, { operative: op, target, weaponName });
  const chk = checkTarget(ctx, state, op, target, profile, rules);
  return chk.valid ? { ok: true } : { ok: false, reason: chk.reason ?? 'not a valid target' };
}

registerAction({
  id: SHOOT_TURRET,
  name: 'Shoot (Turret)',
  ap: 1,
  type: 'unique',
  sourceText: TURRET_TEXT,
  available: (_ctx, _state, op) => op.datacardId === CARD.servoSentry,
  check(ctx, state, op, params) {
    if (!did(op, 'Shoot')) return { ok: false, reason: 'Turret is the second Shoot action of an activation' };
    const shot = defaultShot(ctx, state, op, params);
    const base = getAction('Shoot')!.check(ctx, state, op, { ...params, ...shot });
    if (!base.ok) return base;
    return targetIsValid(ctx, state, op, shot.weaponName, shot.profileName, shot.targetId);
  },
  perform: (ctx, state, op, params) =>
    getAction('Shoot')!.perform(ctx, state, op, { ...params, ...defaultShot(ctx, state, op, params) }),
});

const GUNFIGHT_TEXT = abilityText(CARD.gunfighter, AB.gunfight);
const LASPISTOLS = 'Hot‑shot laspistols';

/** GUNFIGHT: "…it can only target that enemy operative with its hot-shot laspistols (focused)." */
function gunfightShot(
  state: GameState,
  op: OperativeState,
  params: { targetId?: string; targetOperativeId?: string },
): { ok: boolean; reason?: string; weaponName?: string; profileName?: string; targetId?: string } {
  const debt = effectOn(state, op.id, GUNFIGHT_DEBT);
  if (!debt || !debt.data?.['granted'])
    return { ok: false, reason: 'no enemy operative has shot this operative from within 8"' };
  const targetId = String(debt.data?.['targetId'] ?? '');
  const wanted = params.targetId ?? params.targetOperativeId;
  if (wanted && wanted !== targetId) return { ok: false, reason: 'it can only target that enemy operative' };
  const foe = state.operatives[targetId];
  if (!foe || foe.removed || foe.incapacitated) return { ok: false, reason: 'that enemy operative is gone' };
  return { ok: true, weaponName: LASPISTOLS, profileName: 'focused', targetId };
}

registerAction({
  id: SHOOT_GUNFIGHT,
  name: 'Shoot (Gunfight)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Shoot',
  sourceText: GUNFIGHT_TEXT,
  available: (_ctx, state, op) =>
    op.datacardId === CARD.gunfighter && Boolean(effectOn(state, op.id, GUNFIGHT_DEBT)?.data?.['granted']),
  check(ctx, state, op, params) {
    const shot = gunfightShot(state, op, params);
    if (!shot.ok) return { ok: false, ...(shot.reason ? { reason: shot.reason } : {}) };
    // "(you can change its order to Engage to do so)" — the Shoot action's Conceal ban is lifted.
    const probe: OperativeState = op.order === 'conceal' ? { ...op, order: 'engage' } : op;
    const base = getAction('Shoot')!.check(ctx, state, probe, {
      ...params,
      weaponName: shot.weaponName!,
      profileName: shot.profileName!,
      targetId: shot.targetId!,
    });
    if (!base.ok) return base;
    return targetIsValid(ctx, state, probe, shot.weaponName, shot.profileName, shot.targetId);
  },
  perform(ctx, state, op, params) {
    const shot = gunfightShot(state, op, params);
    if (!shot.ok) return { ok: false, ...(shot.reason ? { reason: shot.reason } : {}) };
    const debt = effectOn(state, op.id, GUNFIGHT_DEBT)!;
    op.order = 'engage';
    // The dice cap travels with the shot, and the debt is spent.
    effect(state, {
      rule: GUNFIGHT_SHOT,
      source: { kind: 'ability', id: AB.gunfight },
      sourceText: shortQuote(GUNFIGHT_TEXT),
      operativeId: op.id,
      player: op.player,
      data: { dice: Number(debt.data?.['dice'] ?? 1) },
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    dropEffects(state, (e) => e.rule === GUNFIGHT_DEBT && e.operativeId === op.id);
    // GUNFIGHT_SHOT lives to the end of the activation rather than being dropped here: the shoot
    // sequence can suspend on a decision, and the free AP is the operative's last by construction
    // (D-100), so no other shot of its can pick the cap up.
    return getAction('Shoot')!.perform(ctx, state, op, {
      ...params,
      weaponName: shot.weaponName!,
      profileName: shot.profileName!,
      targetId: shot.targetId!,
    });
  },
});

const DYNAMIC_TEXT = abilityText(CARD.precursor, AB.dynamic);

/**
 * "It can do so even if it's performed the Charge action during this activation, but can only use
 * any remaining move distance it had from that Charge action (to a maximum of 3")."
 */
export function dynamicDashCap(ctx: GameContext, state: GameState, op: OperativeState): number {
  if (!did(op, 'Charge')) return 3;
  const budget = moveOf(ctx, state, op) + 2; // "Charge: move up to its Move stat plus 2""
  let used = 0;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const entry = state.log[i]!;
    if (entry.data?.['operativeId'] !== op.id) continue;
    if (entry.data?.['action'] !== 'Charge') continue;
    const inches = entry.data['inches'];
    if (typeof inches === 'number') {
      used = inches;
      break;
    }
  }
  return Math.max(0, Math.min(3, budget - used));
}

registerAction({
  id: DASH_DYNAMIC,
  name: 'Dash (Dynamic)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Dash',
  sourceText: DYNAMIC_TEXT,
  available: (_ctx, _state, op) => op.datacardId === CARD.precursor,
  check(ctx, state, op, params) {
    if (!did(op, 'Charge')) return { ok: false, reason: 'use the normal Dash action when it has not charged' };
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const v = validateMove(ctx, state, op, params.path, {
      action: 'Dash',
      noClimb: true,
      mustNotFinishEngaged: true,
      hardCap: dynamicDashCap(ctx, state, op),
    });
    return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'illegal move' };
  },
  perform(ctx, state, op, params) {
    const cap = dynamicDashCap(ctx, state, op);
    const v = validateMove(ctx, state, op, params.path!, {
      action: 'Dash',
      noClimb: true,
      mustNotFinishEngaged: true,
      hardCap: cap,
    });
    if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal move' };
    op.pos = { ...v.endPos };
    op.z = v.endZ;
    op.onGuard = false;
    if (op.carryingMarkerId) {
      const m = state.markers[op.carryingMarkerId];
      if (m) {
        m.pos = { ...op.pos };
        m.z = op.z;
      }
    }
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter} performs Dash (Dynamic) (${v.total}", cap ${cap}")`,
      data: { operativeId: op.id, action: 'Dash', inches: v.total },
    });
    return { ok: true };
  },
});

const RAPID_TEXT = abilityText(CARD.trooper, AB.rapidInsertion);

/** "…but must end that move wholly within 3" of your drop zone." */
function endsNearDropZone(ctx: GameContext, state: GameState, op: OperativeState, end: Vec2): boolean {
  const zone = dropZonePolys(state, op.player);
  if (zone.length === 0) return false;
  const base = cardOf(ctx, op).base;
  const pts = [end, ...basePerimeter(end, base, op.rot, 16)];
  return pts.every((p) => zone.some((poly) => distancePointToPoly(p, poly) <= 3 + EPS));
}

registerAction({
  id: REPOSITION_RAPID,
  name: 'Reposition (Rapid Insertion)',
  ap: 1,
  type: 'unique',
  treatedAs: 'Reposition',
  sourceText: RAPID_TEXT,
  available: (_ctx, _state, op) => op.datacardId === CARD.trooper,
  check(ctx, state, op, params) {
    const base = getAction('Reposition')!.check(ctx, state, op, params);
    if (!base.ok) return base;
    if (!params.path) return { ok: false, reason: 'no path supplied' };
    const end = params.path.points[params.path.points.length - 1];
    if (!end) return { ok: false, reason: 'no path supplied' };
    if (!endsNearDropZone(ctx, state, op, end))
      return { ok: false, reason: 'it must end that move wholly within 3" of your drop zone' };
    return { ok: true };
  },
  perform: (ctx, state, op, params) => getAction('Reposition')!.perform(ctx, state, op, params),
});

/**
 * GRENADIER › "This operative can use … smoke and stun grenades." The universal Smoke/Stun Grenade
 * actions are gated on the Utility Grenades equipment, so the GRENADIER gets its own pair (the
 * Kommandos Taktical Wot-notz / Hearthkyn GRENADIER shape). "Doing so doesn't count towards any
 * limited uses you have" — the kill team's grenade budget is restored after the delegated perform.
 */
function grenadierGrenade(id: string, name: string, delegate: string): void {
  registerAction({
    id,
    name,
    ap: 1,
    type: 'unique',
    treatedAs: delegate,
    sourceText: abilityText(CARD.grenadier, AB.grenadier),
    available: (_ctx, _state, op) => op.datacardId === CARD.grenadier,
    check(ctx, state, op, params) {
      return getAction(delegate)!.check(ctx, withGrenadeBudgetIgnored(state, op.player), op, params);
    },
    perform(ctx, state, op, params) {
      const uses = { ...state.teams[op.player].equipmentUses };
      state.teams[op.player].equipmentUses = {
        ...withGrenadeBudgetIgnored(state, op.player).teams[op.player].equipmentUses,
      };
      const res = getAction(delegate)!.perform(ctx, state, op, params);
      state.teams[op.player].equipmentUses = uses;
      return res;
    },
  });
}

grenadierGrenade(SMOKE_GRENADIER, 'Smoke Grenade (Aquilon Grenadier)', 'Smoke Grenade');
grenadierGrenade(STUN_GRENADIER, 'Stun Grenade (Aquilon Grenadier)', 'Stun Grenade');

// ---------------------------------------------------------------------------

export const tempestusAquilons = defineTeam({
  id: 'tempestus-aquilons',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    /*
     * "Use this firefight ploy after rolling your attack dice for a friendly TEMPESTUS AQUILON
     * operative that's wholly within your opponent's territory, or either landed or dropped from
     * Vantage terrain at least 2" higher than the killzone floor during this activation."
     *
     * A shoot sequence runs to completion inside the Shoot action's `perform`, and the AI only
     * gets a turn when there is no in-flight sequence — so requiring one here would make the
     * ploy human-only. It is instead declared during the qualifying operative's activation (the
     * Mandrakes SHADOW'S BITE / Raveners SUBTERRANEAN HORROR shape) and read back at
     * `onRollAttack`, which re-tests every printed condition including the target's 6".
     */
    [FP.hotDrop]: (state, player) => {
      const seq = state.sequence;
      if (seq?.kind === 'shoot' && seq.attacker === player) {
        const shooter = state.operatives[seq.attackerId];
        if (shooter && hotDropReady(state, player, shooter)) return { ok: true };
      }
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player || !isAquilon(active))
        return { ok: false, reason: 'no friendly TEMPESTUS AQUILON operative is activating' };
      return hotDropReady(state, player, active)
        ? { ok: true }
        : {
            ok: false,
            reason:
              'it is not wholly within your opponent’s territory, and has not landed or dropped from Vantage terrain during this activation',
          };
    },
    // "Use this firefight ploy when a friendly TEMPESTUS AQUILON operative lands."
    [FP.adjustCoordinates]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      return active && active.player === player && isAbove(state, active)
        ? { ok: true }
        : { ok: false, reason: 'use it when a friendly TEMPESTUS AQUILON operative lands' };
    },
    // "…during a friendly TEMPESTUS AQUILON operative's activation (excluding SERVO-SENTRY and
    //  any operative that has an APL stat higher than 2)."
    [FP.tempestusExemplars]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player) return { ok: false, reason: 'no friendly operative is activating' };
      if (active.datacardId === CARD.servoSentry) return { ok: false, reason: 'excluding SERVO-SENTRY' };
      if ((catalogueCard(active.datacardId)?.apl ?? 2) > 2)
        return { ok: false, reason: 'excluding any operative that has an APL stat higher than 2' };
      return { ok: true };
    },
    // "…when a friendly TEMPESTUS AQUILON operative (excluding SERVO-SENTRY) is activated."
    [FP.progena]: (state, player) => {
      const active = state.activeOperativeId ? state.operatives[state.activeOperativeId] : undefined;
      if (!active || active.player !== player || !isAquilon(active))
        return { ok: false, reason: 'no friendly TEMPESTUS AQUILON operative is activating' };
      if (active.datacardId === CARD.servoSentry) return { ok: false, reason: 'excluding SERVO-SENTRY' };
      return { ok: true };
    },
  },
  aiHints: {
    roles: {
      [CARD.tempestor]: 'leader',
      [CARD.grenadier]: 'gunner',
      [CARD.gunfighter]: 'gunner',
      [CARD.gunner]: 'gunner',
      [CARD.marksman]: 'sniper',
      [CARD.precursor]: 'scout',
      [CARD.servoSentry]: 'support',
      [CARD.trooper]: 'objective',
    },
    ployValue: {
      [SP.suddenOffensive]: 0.55,
      [SP.maintainMomentum]: 0.6,
      [SP.eyeAbove]: 0.45,
      [SP.dropAndSecure]: 0.5,
      [FP.hotDrop]: 0.55,
      [FP.adjustCoordinates]: 0.3,
      [FP.tempestusExemplars]: 0.35,
      [FP.progena]: 0.5,
      [DROP_MARKER_GAMBIT]: 0.4,
      [RAPID_INSERTION_GAMBIT]: 0.6,
    },
    equipmentValue: {
      [EQ.tempestusDaggers]: 0.6,
      [EQ.combatStimms]: 0.5,
      [EQ.dropAugury]: 0.35,
      [EQ.remoteOverseer]: 0.05,
    },
  },
});

export default tempestusAquilons;
