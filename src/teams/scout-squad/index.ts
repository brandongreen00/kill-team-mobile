/**
 * SCOUT SQUAD — Space Marines. https://wahapedia.ru/kill-team3/kill-teams/scout-squad/
 *
 * Every hook carries a verbatim quote of the printed rule in its RuleBinding; the text is
 * read from `data/teams/scout-squad.json`, never retyped.
 *
 * Two shapes are borrowed wholesale from batch 1, as the brief asks:
 *  - the SERGEANT's Astartes ability is the Angels of Death `Shoot (Astartes)` /
 *    `Fight (Astartes)` pair (docs/DECISIONS.md D-021) — here it also carries the ASTARTES
 *    TRAINING firefight ploy, which grants the same two actions to any friendly operative;
 *  - the WARRIOR's Adaptive Equipment is the Kommandos `Taktical Wot-notz` pair, which
 *    delegates to the universal grenade actions and then restores the kill team's grenade
 *    budget ("doesn't count towards their action limits").
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { terrain, type GameContext } from '../../core/context.ts';
import { withGrenadeBudgetIgnored } from '../../core/equipment/grenades.ts';
import {
  baseGapToPoly,
  basePerimeter,
  baseWhollyWithin,
  dist,
  distancePointToPoly,
  distancePointToSegment,
} from '../../core/geometry.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { validateMove } from '../../core/movement.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  gapBetween,
  inflictDamage,
  log,
  markerContestedBy,
  recordRoll,
  settleZ,
  weaponsOf,
} from '../../core/state.ts';
import { isVisible, coverAndObscured } from '../../core/visibility.ts';
import type { MovePath } from '../../core/intents.ts';
import type { ShootSequence } from '../../core/sequences/types.ts';
import type { Datacard, GameState, OperativeState, Order, PlayerId, Vec2, Weapon } from '../../core/types.ts';
import { otherPlayer } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  bucket,
  chosenOperative,
  currentApl,
  defineTeam,
  dropEffects,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  grantWeapon,
  hasEquipment,
  notEngaged,
  placeTeamMarker,
  removeMarker,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('scout-squad');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!
    .text;
const cardOf = (id: string): Datacard => DATA.datacards.find((c) => c.id === id)!;
const abilityText = (cardId: string, abilityId: string): string =>
  cardOf(cardId).abilities.find((a) => a.id === abilityId)!.text;
const actionText = (cardId: string, actionId: string): string =>
  cardOf(cardId).uniqueActions.find((a) => a.id === actionId)!.text;

const KW = 'SCOUT SQUAD';
const EPS = 1e-6;

/** "an Astartes shotgun, bolt pistol or boltgun must be selected for at least one of them" */
const ASTARTES_LIGHT = ['astartes shotgun', 'bolt pistol', 'boltgun'];
/** "two Shoot actions with a heavy bolter, missile launcher or sniper rifle" */
const ASTARTES_HEAVY = ['heavy bolter', 'missile launcher', 'sniper rifle'];
const isLightAstartes = (name: string): boolean => ASTARTES_LIGHT.includes(name.trim().toLowerCase());
const isHeavyAstartes = (name: string): boolean => ASTARTES_HEAVY.includes(name.trim().toLowerCase());

const MOVE_ACTIONS = ['Reposition', 'Dash', 'Charge', 'Fall Back', 'Move With Barricade'];

// Effect / token rule names (all namespaced — architecture rule 7: no module-level state).
const TRACK_TOKEN = 'scoutSquad.trackEnemy';
const SCAN_SOURCE = 'scoutSquad.auspexScan';
const OPTICS = 'scoutSquad.optics';
const TARGET_TOKEN = 'scoutSquad.targetToken';
const AMBUSH_READY = 'scoutSquad.ambushReady';
const RAW_PHYSIOLOGY = 'scoutSquad.rawPhysiology';
const COVERT_POSITION = 'scoutSquad.covertPosition';
const ASTARTES_TRAINING = 'scoutSquad.astartesTraining';
const LAST_RANGED = 'scoutSquad.lastRanged';
const GUIDANCE_APL = 'scoutSquad.guidance';
const TACTICAL_MANOEUVRE_APL = 'scoutSquad.tacticalManoeuvre';
const DIVERSION_APL = 'scoutSquad.diversion';

const shootSeq = (state: GameState): ShootSequence | undefined =>
  state.sequence?.kind === 'shoot' ? state.sequence : undefined;

// ---------------------------------------------------------------------------
// Namespaced scratch space
// ---------------------------------------------------------------------------

/** The order an operative had BEFORE its current activation (AMBUSH reads it). */
function prevOrders(state: GameState): Record<string, Order> {
  return bucket(state, 'scoutSquad.prevOrder') as Record<string, Order>;
}

/** Elevation at the start of the current activation (Grapnel Assault reads it). */
function activationZ(state: GameState): Record<string, number> {
  return bucket(state, 'scoutSquad.activationZ') as Record<string, number>;
}

/** Friendly operatives that performed Shoot/Fight this turning point, in order. */
function attackOrder(state: GameState, player: PlayerId): string[] {
  const b = bucket(state, 'scoutSquad.attackOrder');
  const key = `${player}:${state.turningPoint}`;
  const list = (b[key] ?? []) as string[];
  b[key] = list;
  return list;
}

/** The Forward Scouting options this player selected at the end of Set Up Operatives. */
export function forwardScoutingSelections(state: GameState, player: PlayerId): ForwardScoutingOption[] {
  const b = bucket(state, 'scoutSquad.forwardScouting');
  return ((b[player] ?? []) as ForwardScoutingOption[]).slice();
}

/** "Twice per battle STRATEGIC GAMBIT" / "Once per battle" — `gambitsUsedTP` resets each TP. */
function battleGambitUses(state: GameState, key: string): number {
  return Number((bucket(state, 'scoutSquad.gambitUses')[key] ?? 0) as number);
}
function spendBattleGambit(state: GameState, key: string): void {
  bucket(state, 'scoutSquad.gambitUses')[key] = battleGambitUses(state, key) + 1;
}

// ---------------------------------------------------------------------------
// Forward Scouting (faction rule)
// ---------------------------------------------------------------------------

/**
 * "Each option has a number in brackets, which is the maximum number of times you can select
 * and resolve it for the battle."
 */
export const FORWARD_SCOUTING_LIMITS = {
  redeploy: 1,
  reposition: 2,
  'trip-alarm': 2,
  'booby-trap': 1,
  'tactical-manoeuvre': 1,
  diversion: 1,
  'devise-plan': 1,
  'designate-target': 1,
  spy: 1,
} as const;

export type ForwardScoutingOption = keyof typeof FORWARD_SCOUTING_LIMITS;

/** "you can select and resolve up to six Forward Scouting options" */
export const FORWARD_SCOUTING_MAX = 6;

export interface ForwardScoutingPick {
  option: ForwardScoutingOption;
  /** Trip Alarm / Booby Trap marker position. */
  pos?: Vec2;
  /** Reposition: the friendly operative; Designate Target: the enemy operative. */
  operativeId?: string;
  /** Reposition: the free Reposition move. */
  path?: MovePath;
  /** Redeploy: the operatives to set up again, and where. */
  placements?: { operativeId: string; pos: Vec2; z?: number; rotDeg?: number }[];
}

export interface ForwardScoutingResult {
  ok: boolean;
  resolved: ForwardScoutingOption[];
  errors: string[];
}

const TRIP_ALARM_MARKER = (player: PlayerId, n: number): string => `scout-squad.tripAlarm.${player}.${n}`;
const BOOBY_TRAP_MARKER = (player: PlayerId): string => `scout-squad.boobyTrap.${player}`;

const dropZonePolys = (state: GameState, player: PlayerId): Vec2[][] =>
  state.map.dropZones[state.setup.dropZone[player] ?? player] ?? [];

/** Base-to-drop-zone gap in inches (0 while any part of the base is inside it). */
function gapToDropZone(state: GameState, player: PlayerId, pos: Vec2, base: Datacard['base'], rot: number): number {
  const zones = dropZonePolys(state, player);
  if (zones.length === 0) return Infinity;
  return Math.min(...zones.map((poly) => baseGapToPoly(pos, base, rot, poly)));
}

/** "wholly within x" of your drop zone" — EVERY point of the base is within x". */
function baseWhollyWithinOfDropZone(
  state: GameState,
  player: PlayerId,
  pos: Vec2,
  base: Datacard['base'],
  rot: number,
  inches: number,
): boolean {
  const zones = dropZonePolys(state, player);
  if (zones.length === 0) return false;
  const pts = [pos, ...basePerimeter(pos, base, rot, 32)];
  return pts.every((p) => zones.some((poly) => distancePointToPoly(p, poly) <= inches + EPS));
}

const MARKER_BASE = { shape: 'round', mm: 20 } as const;

/**
 * FORWARD SCOUTING: "At the end of the Set Up Operatives step, you can select and resolve up
 * to six Forward Scouting options."
 *
 * The engine has no decision channel during setup (`onBattleSetup` is declared but never
 * emitted — docs/TEAM-STATUS.md § Known engine gaps), so the selection is made through this
 * pure setter, exactly as the Angels of Death chapter tactics are (docs/DECISIONS.md D-017).
 * Nothing is selected by default: an option that was not selected simply never applies.
 *
 * "If both players have this rule, alternate resolving selection by selection, starting with
 * the player with initiative" is the caller's ordering problem — it is a sequencing rule for
 * the setup UI, not a mechanical effect.
 */
export function selectForwardScouting(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  picks: ForwardScoutingPick[],
): ForwardScoutingResult {
  const errors: string[] = [];
  const resolved: ForwardScoutingOption[] = [];
  const counts = new Map<ForwardScoutingOption, number>();

  for (const pick of picks) {
    if (resolved.length >= FORWARD_SCOUTING_MAX) {
      errors.push('you can select and resolve up to six Forward Scouting options');
      break;
    }
    const limit: number | undefined = (FORWARD_SCOUTING_LIMITS as Record<string, number>)[pick.option];
    if (limit === undefined) {
      errors.push(`'${pick.option}' is not a Forward Scouting option`);
      continue;
    }
    const used = counts.get(pick.option) ?? 0;
    if (used >= limit) {
      errors.push(`${pick.option} can be selected at most ${limit} time(s) for the battle`);
      continue;
    }
    const outcome = resolveForwardScouting(ctx, state, player, pick, used);
    if (!outcome.ok) {
      errors.push(outcome.reason ?? `${pick.option} could not be resolved`);
      continue;
    }
    counts.set(pick.option, used + 1);
    resolved.push(pick.option);
  }

  const store = bucket(state, 'scoutSquad.forwardScouting');
  store[player] = [...((store[player] ?? []) as ForwardScoutingOption[]), ...resolved];
  log(state, {
    kind: 'system',
    player,
    text: `Forward Scouting: ${resolved.length > 0 ? resolved.join(', ') : 'nothing selected'}`,
  });
  return { ok: errors.length === 0, resolved, errors };
}

function resolveForwardScouting(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  pick: ForwardScoutingPick,
  already: number,
): { ok: boolean; reason?: string } {
  const mine = aliveOperatives(state, player);
  switch (pick.option) {
    // "Devise Plan(1) — You gain 1CP."
    case 'devise-plan': {
      state.teams[player].cp += 1;
      return { ok: true };
    }

    // "Spy(1) — Approved Ops only. Your opponent must reveal their selected tac op."
    case 'spy': {
      state.setup.revealed[otherPlayer(player)] = true;
      return { ok: true };
    }

    // "Designate Target(1) — Select one enemy operative to gain one of your Target tokens."
    case 'designate-target': {
      const foes = aliveOperatives(state, otherPlayer(player));
      const target = pick.operativeId
        ? foes.find((o) => o.id === pick.operativeId)
        : [...foes].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      if (!target) return { ok: false, reason: 'select one enemy operative' };
      effect(state, {
        rule: TARGET_TOKEN,
        source: { kind: 'ability', id: 'scout-squad.rule.forward-scouting' },
        sourceText: shortQuote(text('scout-squad.rule.forward-scouting')),
        operativeId: target.id,
        player,
        expiry: { kind: 'endOfBattle' },
      });
      return { ok: true };
    }

    // "Trip Alarm(2) — Place one of your Trip Alarm markers more than 6" from your
    //  opponent's drop zone."
    case 'trip-alarm': {
      const fallback = defaultMarkerPos(state, player, mine);
      const pos = pick.pos ?? fallback;
      const gap = gapToDropZone(state, otherPlayer(player), pos, MARKER_BASE, 0);
      if (gap <= 6 + EPS)
        return { ok: false, reason: 'a Trip Alarm marker must be more than 6" from your opponent’s drop zone' };
      placeTeamMarker(state, { id: TRIP_ALARM_MARKER(player, already), kind: 'generic', player, pos });
      return { ok: true };
    }

    // "Booby Trap(1) — Place one of your Booby Trap markers more than 6" from your opponent's
    //  drop zone and more than 2" from other markers, access points and Accessible terrain.
    //  ... If it cannot be placed, move it the minimum amount to do so."
    case 'booby-trap': {
      const wanted = pick.pos ?? defaultMarkerPos(state, player, mine);
      const pos = nudgeBoobyTrap(ctx, state, player, wanted);
      if (!pos) return { ok: false, reason: 'no legal position for the Booby Trap marker' };
      placeTeamMarker(state, {
        id: BOOBY_TRAP_MARKER(player),
        kind: 'generic',
        player,
        pos,
        flags: { boobyTrap: true },
      });
      return { ok: true };
    }

    // "Redeploy(1) — Change the set up of one third of your operatives (rounding up)."
    case 'redeploy': {
      const allowed = Math.ceil(mine.length / 3);
      const placements = pick.placements ?? [];
      if (placements.length > allowed)
        return { ok: false, reason: `you can change the set up of ${allowed} operatives (one third, rounding up)` };
      const zone = dropZonePolys(state, player);
      for (const p of placements) {
        const op = state.operatives[p.operativeId];
        if (!op || op.player !== player) return { ok: false, reason: 'no such friendly operative' };
        const card = ctx.datacards.get(op.datacardId);
        if (!card) return { ok: false, reason: 'unknown datacard' };
        const rot = p.rotDeg ?? op.rot;
        if (!baseWhollyWithin(p.pos, card.base, rot, zone))
          return { ok: false, reason: 'operatives must be set up wholly within your drop zone' };
      }
      for (const p of placements) {
        const op = state.operatives[p.operativeId]!;
        op.pos = { ...p.pos };
        op.rot = p.rotDeg ?? op.rot;
        if (p.z !== undefined) op.z = p.z;
        else settleZ(ctx, state, op);
      }
      return { ok: true };
    }

    // "Reposition(2) — Perform a free Reposition action with one friendly operative that's
    //  wholly within your drop zone. It must end that move wholly within 3" of your drop zone."
    case 'reposition': {
      const op = pick.operativeId ? state.operatives[pick.operativeId] : undefined;
      if (!op || op.player !== player || op.removed) return { ok: false, reason: 'select one friendly operative' };
      const card = ctx.datacards.get(op.datacardId);
      if (!card) return { ok: false, reason: 'unknown datacard' };
      if (!baseWhollyWithin(op.pos, card.base, op.rot, dropZonePolys(state, player)))
        return { ok: false, reason: 'that operative is not wholly within your drop zone' };
      if (!pick.path) return { ok: false, reason: 'no Reposition path supplied' };
      const v = validateMove(ctx, state, op, pick.path, { action: 'Reposition', mustNotFinishEngaged: true });
      if (!v.ok) return { ok: false, reason: v.reason ?? 'illegal Reposition' };
      const rot = pick.path.endRot ?? op.rot;
      if (!baseWhollyWithinOfDropZone(state, player, v.endPos, card.base, rot, 3))
        return { ok: false, reason: 'it must end that move wholly within 3" of your drop zone' };
      op.pos = { ...v.endPos };
      op.z = v.endZ;
      op.rot = rot;
      return { ok: true };
    }

    // Both of these are STRATEGIC GAMBITs; selecting the option is what unlocks them.
    case 'tactical-manoeuvre':
    case 'diversion':
      return { ok: true };
  }
}

/** A deterministic default marker position: the centre of the player's own half. */
function defaultMarkerPos(state: GameState, player: PlayerId, mine: OperativeState[]): Vec2 {
  if (mine.length > 0) {
    const sum = mine.reduce((a, o) => ({ x: a.x + o.pos.x, y: a.y + o.pos.y }), { x: 0, y: 0 });
    return { x: sum.x / mine.length, y: sum.y / mine.length };
  }
  const { w, h } = state.map.board;
  return { x: player === 'p1' ? w / 4 : (w * 3) / 4, y: h / 2 };
}

/** "If it cannot be placed, move it the minimum amount to do so." */
function nudgeBoobyTrap(ctx: GameContext, state: GameState, player: PlayerId, wanted: Vec2): Vec2 | undefined {
  const blocked = terrain(ctx, state).parts.filter((p) => p.typeSet.has('Accessible') || p.role === 'accessPoint');
  const markers = Object.values(state.markers).map((m) => m.pos);
  const legal = (p: Vec2): boolean => {
    if (p.x < 0 || p.y < 0 || p.x > state.map.board.w || p.y > state.map.board.h) return false;
    if (gapToDropZone(state, otherPlayer(player), p, MARKER_BASE, 0) <= 6 + EPS) return false;
    for (const m of markers) if (dist(m, p) <= 2 + EPS) return false;
    for (const part of blocked) if (baseGapToPoly(p, MARKER_BASE, 0, part.poly) <= 2 + EPS) return false;
    return true;
  };
  if (legal(wanted)) return { ...wanted };
  // Deterministic outward search in 0.25" rings, so "the minimum amount" is reproducible.
  for (let r = 0.25; r <= 8 + EPS; r += 0.25) {
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const p = { x: wanted.x + r * Math.cos(a), y: wanted.y + r * Math.sin(a) };
      if (legal(p)) return p;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Faction rule + datacard abilities
// ---------------------------------------------------------------------------

/** "…an enemy operative within 8" of this operative" while the TRACKER's scan is live. */
function isScanned(T: TeamHooks, state: GameState, op: OperativeState): boolean {
  return state.effects.some((e) => {
    if (e.rule !== SCAN_SOURCE || e.player !== T.player) return false;
    const scanner = e.operativeId ? state.operatives[e.operativeId] : undefined;
    // "or until it's incapacitated (whichever comes first)"
    if (!scanner || scanner.removed || scanner.incapacitated) return false;
    return T.gap(scanner, op) <= 8 + EPS;
  });
}

/** Every operative that can see this one right now. */
function seenBy(T: TeamHooks, state: GameState, op: OperativeState, watchers: OperativeState[]): OperativeState[] {
  if (!T.ctx) return [];
  const index = terrain(T.ctx, state);
  const target = body(T.ctx, op);
  return watchers.filter((w) => !w.removed && isVisible(index, body(T.ctx!, w), target).visible);
}

function rules(reg: HookRegistry, T: TeamHooks): void {
  const FS = 'scout-squad.rule.forward-scouting';
  const selected = (state: GameState, option: ForwardScoutingOption): boolean =>
    forwardScoutingSelections(state, T.player).includes(option);

  // ---- FORWARD SCOUTING › Trip Alarm ------------------------------------
  // "During the first and second turning point, whenever a friendly SCOUT SQUAD operative is
  //  shooting an enemy operative that's within 2" of that marker, that friendly operative's
  //  ranged weapons have the Seek weapon rule."
  reg.on('onWeaponRules', T.bind(FS, 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    if (ev.state.turningPoint > 2) return;
    const near = Object.values(ev.state.markers).some(
      (m) => m.id.startsWith(`scout-squad.tripAlarm.${T.player}.`) && T.markerGap(ev.target!, m) <= 2 + EPS,
    );
    if (!near) return;
    ev.rules.push(ruleTag('Seek', undefined, 'Seek (Trip Alarm)'));
  });
  // "In the Ready step of the third Strategy phase, remove that marker."
  reg.on('onReadyStep', T.bind(FS, 13), (ev) => {
    if (ev.player !== T.player || ev.state.turningPoint < 3) return;
    for (const m of Object.values(ev.state.markers))
      if (m.id.startsWith(`scout-squad.tripAlarm.${T.player}.`)) removeMarker(ev.state, m.id);
  });

  // ---- FORWARD SCOUTING › Booby Trap ------------------------------------
  // "The first time your Booby Trap marker is within an enemy operative's control range,
  //  remove that marker and inflict 2D3 damage on that operative."
  //
  // PARTIAL: `checkMines` in `src/core/actions.ts` is the only marker-trigger the engine has
  // and it is core-only (kind 'mine', D3+3, any player). There is no hook emitted from
  // `applyMove`, so the trap is sprung at the activation boundaries instead — the damage
  // lands, but "end its action" cannot be honoured. Reported as a seam.
  const springTraps = (state: GameState): void => {
    if (!T.ctx) return;
    const marker = state.markers[BOOBY_TRAP_MARKER(T.player)];
    if (!marker) return;
    const victim = T.enemies(state).find((e) => markerContestedBy(T.ctx!, state, marker, e));
    if (!victim) return;
    removeMarker(state, marker.id);
    const damage = T.ctx.rng.d3() + T.ctx.rng.d3();
    recordRoll(state, 'boobyTrap', [damage], T.player, 'Booby Trap 2D3');
    log(state, { kind: 'action', player: T.player, text: `${victim.letter} triggers a Booby Trap (${damage} damage)` });
    inflictDamage(T.ctx, state, victim, damage, 'mine');
  };
  reg.on('onActivationStart', T.bind(FS, 14), (ev) => springTraps(ev.state));
  reg.on('onActivationEnd', T.bind(FS, 15), (ev) => springTraps(ev.state));

  // ---- FORWARD SCOUTING › Designate Target ------------------------------
  // "Whenever a friendly SCOUT SQUAD operative is shooting against, fighting against or
  //  retaliating against an enemy operative that has one of your Target tokens, you can
  //  re-roll one of your attack dice."
  reg.on('onRollAttack', T.bind(FS, 16), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const foe = ev.ctx.defender;
    if (!foe || !hasTargetToken(ev.state, foe.id, T.player)) return;
    ev.rerolls.push({
      id: 'scoutSquad.designateTarget',
      label: 'Designate Target: re-roll one of your attack dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text(FS)),
    });
  });
  // `onRollAttack` is never emitted by `src/core/sequences/fight.ts`, so the fighting and
  // retaliating half is expressed as the Balanced weapon rule — whose printed definition is
  // the same sentence ("You can re-roll one of your attack dice"). Reported as a seam,
  // because a weapon that already has Balanced gets nothing extra from it.
  reg.on('onWeaponRules', T.bind(FS, 17), (ev) => {
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!hasTargetToken(ev.state, ev.target.id, T.player)) return;
    ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Designate Target)'));
  });

  // ---- FORWARD SCOUTING › Tactical Manoeuvre / Diversion ----------------
  // "Twice per battle STRATEGIC GAMBIT. Select one friendly operative. Until the end of that
  //  operative's next activation, add 1 to its APL stat."
  reg.on('gambitOptions', T.bind(FS, 18), (ev) => {
    if (ev.player !== T.player || !selected(ev.state, 'tactical-manoeuvre')) return;
    if (battleGambitUses(ev.state, `tacticalManoeuvre:${T.player}`) >= 2) return;
    ev.options.push({
      id: TACTICAL_MANOEUVRE_GAMBIT,
      label: 'Forward Scouting: Tactical Manoeuvre',
      sourceText: shortQuote(text(FS)),
    });
  });
  // "Once per battle STRATEGIC GAMBIT. Select one enemy operative within 6" of a killzone
  //  edge. Until the end of that operative's next activation, subtract 1 from its APL stat."
  reg.on('gambitOptions', T.bind(FS, 19), (ev) => {
    if (ev.player !== T.player || !selected(ev.state, 'diversion')) return;
    if (battleGambitUses(ev.state, `diversion:${T.player}`) >= 1) return;
    if (nearKillzoneEdge(ev.state, T.enemies(ev.state)).length === 0) return;
    ev.options.push({
      id: DIVERSION_GAMBIT,
      label: 'Forward Scouting: Diversion',
      sourceText: shortQuote(text(FS)),
    });
  });
  reg.on('onPloyUsed', T.bind(FS, 20), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.ployId === TACTICAL_MANOEUVRE_GAMBIT) {
      const op = chosenOperative(ev.state, ev.data, T.friendlies(ev.state));
      if (!op) return;
      spendBattleGambit(ev.state, `tacticalManoeuvre:${T.player}`);
      op.aplMods.push(1);
      effect(ev.state, {
        rule: TACTICAL_MANOEUVRE_APL,
        source: { kind: 'ploy', id: FS },
        sourceText: shortQuote(text(FS)),
        operativeId: op.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
      });
      log(ev.state, { kind: 'ploy', player: T.player, text: `Tactical Manoeuvre: ${op.letter} +1 APL` });
    } else if (ev.ployId === DIVERSION_GAMBIT) {
      const op = chosenOperative(ev.state, ev.data, nearKillzoneEdge(ev.state, T.enemies(ev.state)));
      if (!op) return;
      spendBattleGambit(ev.state, `diversion:${T.player}`);
      op.aplMods.push(-1);
      effect(ev.state, {
        rule: DIVERSION_APL,
        source: { kind: 'ploy', id: FS },
        sourceText: shortQuote(text(FS)),
        operativeId: op.id,
        player: T.player,
        expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
      });
      log(ev.state, { kind: 'ploy', player: T.player, text: `Diversion: ${op.letter} -1 APL` });
    }
  });

  // ---- Bookkeeping every rule below reads --------------------------------
  reg.on('onDeploy', T.bind(FS, 5), (ev) => {
    // Operatives are set up with a Conceal order, which is the order AMBUSH compares against.
    if (ev.operative.player === T.player) prevOrders(ev.state)[ev.operative.id] = ev.operative.order;
  });
  reg.on('onActivationStart', T.bind(FS, 6), (ev) => {
    if (ev.operative.player !== T.player) return;
    activationZ(ev.state)[ev.operative.id] = ev.operative.z;
    armAmbush(T, ev.state, ev.operative);
  });
  reg.on('onActivationEnd', T.bind(FS, 7), (ev) => {
    // "It has this order until it's next activated" — remember it for the NEXT activation.
    if (ev.operative.player === T.player) prevOrders(ev.state)[ev.operative.id] = ev.operative.order;
  });
  reg.on('onCollectAttackDice', T.bind(FS, 8), (ev) => {
    // The order in which friendly operatives perform Shoot/Fight, for EMBOLDENED ASPIRANT,
    // and the last ranged weapon used, for the Astartes second Shoot.
    const seq = ev.state.sequence;
    const me = ev.ctx.attacker;
    if (me.player !== T.player) return;
    if (seq?.kind === 'fight' && seq.attackerId !== me.id) return; // a retaliation is not an action
    if (ev.ctx.secondary) return;
    const list = attackOrder(ev.state, T.player);
    if (!list.includes(me.id)) list.push(me.id);
    if (ev.ctx.type !== 'ranged') return;
    const existing = effectOn(ev.state, me.id, LAST_RANGED);
    if (existing) existing.data = { weapon: ev.ctx.weaponName };
    else
      effect(ev.state, {
        rule: LAST_RANGED,
        source: { kind: 'core', id: 'scout-squad.sergeant.astartes' },
        operativeId: me.id,
        player: T.player,
        data: { weapon: ev.ctx.weaponName },
        expiry: { kind: 'endOfActivation', operativeId: me.id },
      });
  });

  // ---- SERGEANT › Astartes ----------------------------------------------
  // "During this operative's activation, it can perform either two Shoot actions or two Fight
  //  actions" is the `Shoot (Scout Astartes)` / `Fight (Scout Astartes)` pair registered below.
  //
  // "This operative can counteract regardless of its order."
  //
  // `counteractCandidates` (`src/core/phases.ts`) now emits `onCounteract` for every expended,
  // not-yet-counteracted operative with `allowed: o.order === 'engage'` as the DEFAULT, so this
  // handler widens the list instead of only being able to narrow it. It ONLY ever sets `true`:
  // "expended", "once during the turning point" and the On Guard lockout stay the core's job.
  //
  // "This operative" is the SERGEANT alone — the clause is printed on the SERGEANT datacard's
  // Astartes ability, not on the faction rule, so it is scoped to friendly SCOUT SQUAD
  // operatives with that datacard rather than to the whole kill team.
  reg.on('onCounteract', T.bind('scout-squad.sergeant.astartes', 12), (ev) => {
    if (!T.mineKw(ev.operative, KW)) return;
    if (ev.operative.datacardId !== 'scout-squad.sergeant') return;
    ev.allowed = true;
  });

  // ---- HEAVY GUNNER › Heavy Weapon Bipod --------------------------------
  // "Whenever this operative is shooting with a weapon from its datacard, if it hasn't moved
  //  during the activation, or if it's a counteraction, that weapon has the Ceaseless weapon
  //  rule; if the weapon already has that weapon rule (i.e. from the Ambush strategy ploy), it
  //  has the Relentless weapon rule instead."
  //
  // Priority 25 (above the ploys' 20) so that "already has that weapon rule" can see AMBUSH's
  // Ceaseless — the registry dispatches in ascending priority order.
  reg.on('onWeaponRules', T.bind('scout-squad.heavy-gunner.heavy-weapon-bipod', 25), (ev) => {
    if (ev.type !== 'ranged' || ev.operative.player !== T.player) return;
    if (ev.operative.datacardId !== 'scout-squad.heavy-gunner') return;
    if (!(T.card(ev.operative)?.weapons ?? []).some((w) => w.name === ev.weaponName)) return;
    const counteracting = ev.state.opState['counteract']?.['operativeId'] === ev.operative.id;
    const moved = ev.operative.actionsThisActivation.some((a) => MOVE_ACTIONS.includes(a));
    if (moved && !counteracting) return;
    if (ev.rules.some((r) => r.id === 'Ceaseless'))
      ev.rules.push(ruleTag('Relentless', undefined, 'Relentless (Heavy Weapon Bipod)'));
    else ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Heavy Weapon Bipod)'));
  });

  // ---- HUNTER › Grapnel Assault -----------------------------------------
  // "Whenever this operative performs the Charge action during its activation, if it climbs,
  //  drops, jumps or its base moves underneath Vantage terrain during that action, its melee
  //  weapons have the Lethal 3+ weapon rule until the end of that activation."
  //
  // PARTIAL: nothing in the engine reports the legs of a completed move (`applyMove` keeps
  // `MoveValidation.legs` to itself and `onMoveRules` is never emitted), so a climb or drop is
  // detected as a change of elevation across the activation. A jump that lands at the same
  // height, and "its base moves underneath Vantage terrain", cannot be seen. Reported as a seam.
  reg.on('onWeaponRules', T.bind('scout-squad.hunter.grapnel-assault', 12), (ev) => {
    if (ev.type !== 'melee' || ev.operative.player !== T.player) return;
    if (ev.operative.datacardId !== 'scout-squad.hunter') return;
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    const startZ = activationZ(ev.state)[ev.operative.id];
    if (startZ === undefined || Math.abs(startZ - ev.operative.z) < 0.05) return;
    ev.rules.push(ruleTag('Lethal', 3, 'Lethal 3+ (Grapnel Assault)'));
  });

  // ---- SNIPER › Camo Cloak ----------------------------------------------
  // "Whenever an operative is shooting this operative: Ignore the Saturate weapon rule. If you
  //  can retain any cover saves, you can retain one additional cover save, or you can retain
  //  one cover save as a critical success instead. This isn't cumulative with improved cover
  //  saves from Vantage terrain."
  reg.on('onDefenceDice', T.bind('scout-squad.sniper.camo-cloak', 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.player !== T.player || target.datacardId !== 'scout-squad.sniper') return;
    const seq = shootSeq(ev.state);
    if (!seq || seq.targetId !== target.id) return;
    if (seq.inCover) ev.coverSave = true; // "Ignore the Saturate weapon rule."
    if (!ev.coverSave) return;
    // "This isn't cumulative with improved cover saves from Vantage terrain."
    if (seq.vantageImprovedCover) return;
    // The two options are exclusive ("or"); the additional cover save is the deterministic
    // choice — a second retained normal beats promoting one to a critical in every case where
    // the attacker has more than one success, and never does worse.
    ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // ---- WARRIOR › Adaptive Equipment -------------------------------------
  // "You can do each of the following once per turning point" — the two actions themselves are
  // registered below; this binding is what refuses the second use in the action sheet.
  reg.on('canPerformAction', T.bind('scout-squad.warrior.adaptive-equipment', 12), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (ev.action !== ADAPTIVE_SMOKE && ev.action !== ADAPTIVE_STUN) return;
    if (!adaptiveUsedThisTP(ev.state, T.player, ev.action)) return;
    ev.allowed = false;
    ev.reason = 'you can do each of these once per turning point';
  });

  // ---- TRACKER › TRACK ENEMY (the token's effect) -------------------------
  reg.on('onWeaponRules', T.bind('scout-squad.tracker.act.track-enemy', 12), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!ev.state.effects.some((e) => e.rule === TRACK_TOKEN && e.operativeId === ev.target!.id && e.player === T.player))
      return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (TRACK ENEMY)'));
  });

  // ---- TRACKER › AUSPEX SCAN (the scan's effect) -------------------------
  // "…that enemy operative cannot be obscured"
  reg.on('onCollectAttackDice', T.bind('scout-squad.tracker.act.auspex-scan', 12), (ev) => {
    if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, KW)) return;
    const foe = ev.ctx.defender;
    const seq = shootSeq(ev.state);
    if (!foe || !seq || !isScanned(T, ev.state, foe)) return;
    seq.obscured = false;
  });
  // "…if that friendly operative is a SNIPER that's currently benefitting from the effects of
  //  its Optics action, its ranged weapons also have the Seek Light weapon rule."
  reg.on('onWeaponRules', T.bind('scout-squad.tracker.act.auspex-scan', 13), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW) || !ev.target) return;
    if (!T.kw(ev.operative, 'SNIPER') || !effectOn(ev.state, ev.operative.id, OPTICS)) return;
    if (!isScanned(T, ev.state, ev.target)) return;
    ev.rules.push(ruleTag('SeekLight', undefined, 'Seek Light (AUSPEX SCAN)'));
  });

  // ---- SNIPER › OPTICS (the action's effect) -----------------------------
  // "Until the start of this operative's next activation, whenever it's shooting, enemy
  //  operatives cannot be obscured."
  reg.on('onCollectAttackDice', T.bind('scout-squad.sniper.act.optics', 13), (ev) => {
    if (ev.ctx.type !== 'ranged' || ev.ctx.attacker.player !== T.player) return;
    if (!effectOn(ev.state, ev.ctx.attacker.id, OPTICS)) return;
    const seq = shootSeq(ev.state);
    if (seq) seq.obscured = false;
  });
}

const hasTargetToken = (state: GameState, operativeId: string, player: PlayerId): boolean =>
  state.effects.some((e) => e.rule === TARGET_TOKEN && e.operativeId === operativeId && e.player === player);

/** "Select one enemy operative within 6" of a killzone edge." */
function nearKillzoneEdge(state: GameState, ops: OperativeState[]): OperativeState[] {
  const edges = [
    ...state.map.killzoneEdges.p1,
    ...state.map.killzoneEdges.p2,
    ...state.map.killzoneEdges.neutral,
  ];
  const distanceToEdge = (p: Vec2): number => {
    if (edges.length > 0) return Math.min(...edges.map((e) => distancePointToSegment(p, e.a, e.b)));
    // Maps whose edges were not extracted: the killzone edge IS the board boundary.
    const { w, h } = state.map.board;
    return Math.min(p.x, p.y, w - p.x, h - p.y);
  };
  return ops.filter((o) => distanceToEdge(o.pos) <= 6 + EPS);
}

/**
 * AMBUSH: "…if its order was changed from Conceal to Engage at the start of that activation,
 * or it wasn't visible to enemy operatives at the start of that activation".
 *
 * The reducer writes the new order before emitting `onActivationStart`, so the previous order
 * is remembered at the previous activation's end (and at deployment, where it is Conceal).
 */
function armAmbush(T: TeamHooks, state: GameState, op: OperativeState): void {
  if (!T.kw(op, KW)) return;
  const previous = prevOrders(state)[op.id] ?? 'conceal';
  const flipped = previous === 'conceal' && op.order === 'engage';
  const unseen = seenBy(T, state, op, T.enemies(state)).length === 0;
  if (!flipped && !unseen) return;
  effect(state, {
    rule: AMBUSH_READY,
    source: { kind: 'ploy', id: 'scout-squad.sp.ambush' },
    sourceText: shortQuote(text('scout-squad.sp.ambush')),
    operativeId: op.id,
    player: T.player,
    data: { flipped, unseen },
    expiry: { kind: 'endOfActivation', operativeId: op.id },
  });
}

// ---------------------------------------------------------------------------
// Ploys
// ---------------------------------------------------------------------------

export const TACTICAL_MANOEUVRE_GAMBIT = 'scout-squad.rule.forward-scouting:tactical-manoeuvre';
export const DIVERSION_GAMBIT = 'scout-squad.rule.forward-scouting:diversion';

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // ---- GUERRILLA ENGAGEMENT (strategy, 1CP) ------------------------------
  // "Whenever an enemy operative is shooting a friendly SCOUT SQUAD operative, if that friendly
  //  operative is in cover and more than 6" from enemy operatives it's visible to, you can
  //  re-roll one of your defence dice."
  reg.on('onDefenceDice', T.bind('scout-squad.sp.guerrilla-engagement', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'scout-squad.sp.guerrilla-engagement')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW)) return;
    if (!ev.ctx.inCover) return;
    const tooClose = seenBy(T, ev.state, target, T.enemies(ev.state)).some((e) => T.gap(e, target) <= 6 + EPS);
    if (tooClose) return;
    ev.rerolls.push({
      id: 'scoutSquad.guerrillaEngagement',
      label: 'Guerrilla Engagement: re-roll one of your defence dice',
      mode: 'one',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('scout-squad.sp.guerrilla-engagement')),
    });
  });

  // ---- AMBUSH (strategy, 1CP) --------------------------------------------
  // "…That friendly operative's weapons have the Balanced weapon rule. If the target is
  //  expended, that friendly operative's weapons have the Ceaseless weapon rule instead."
  reg.on('onWeaponRules', T.bind('scout-squad.sp.ambush', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'scout-squad.sp.ambush')) return;
    if (!T.mineKw(ev.operative, KW) || ev.retaliating) return;
    // "Whenever a friendly SCOUT SQUAD operative is shooting or fighting DURING ITS ACTIVATION"
    if (ev.state.activeOperativeId !== ev.operative.id) return;
    if (!effectOn(ev.state, ev.operative.id, AMBUSH_READY)) return;
    if (ev.target?.expended) ev.rules.push(ruleTag('Ceaseless', undefined, 'Ceaseless (Ambush)'));
    else ev.rules.push(ruleTag('Balanced', undefined, 'Balanced (Ambush)'));
  });

  // ---- ADAPTABLE TRAINING (strategy, 1CP) --------------------------------
  // "You can change the order of up to D3 friendly SCOUT SQUAD operatives that are more than
  //  4" from enemy operatives."
  reg.on('onPloyUsed', T.bind('scout-squad.sp.adaptable-training', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'scout-squad.sp.adaptable-training') return;
    const d3 = T.ctx ? T.ctx.rng.d3() : 1;
    recordRoll(ev.state, 'adaptableTraining', [d3], T.player, 'ADAPTABLE TRAINING D3');
    const eligible = T.friendlies(ev.state, KW).filter((o) =>
      T.enemies(ev.state).every((e) => T.gap(o, e) > 4 + EPS),
    );
    for (const op of pickUpTo(ev.data, eligible, d3)) {
      op.order = op.order === 'conceal' ? 'engage' : 'conceal';
      log(ev.state, {
        kind: 'ploy',
        player: T.player,
        text: `Adaptable Training: ${op.letter} changes order to ${op.order}`,
      });
    }
  });

  // ---- STEALTH RELOCATION (strategy, 1CP) --------------------------------
  // "Up to D3 friendly SCOUT SQUAD operatives that have a Conceal order and are more than 4"
  //  from enemy operatives can immediately perform a free Dash action."
  reg.on('onPloyUsed', T.bind('scout-squad.sp.stealth-relocation', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'scout-squad.sp.stealth-relocation') return;
    const d3 = T.ctx ? T.ctx.rng.d3() : 1;
    recordRoll(ev.state, 'stealthRelocation', [d3], T.player, 'STEALTH RELOCATION D3');
    const eligible = T.friendlies(ev.state, KW).filter(
      (o) => o.order === 'conceal' && T.enemies(ev.state).every((e) => T.gap(o, e) > 4 + EPS),
    );
    for (const op of pickUpTo(ev.data, eligible, d3)) {
      grantFreeAction(ev.state, op, {
        sourceId: 'scout-squad.sp.stealth-relocation',
        sourceText: shortQuote(text('scout-squad.sp.stealth-relocation')),
        threshold: currentApl(T, ev.state, op),
        only: ['Dash'],
      });
    }
  });

  // ---- ASTARTES TRAINING (firefight, 1CP) --------------------------------
  // "Use this firefight ploy during a friendly SCOUT SQUAD operative's activation. Until the
  //  end of that activation, that operative can do one of the following…"
  reg.on('onPloyUsed', T.bind('scout-squad.fp.astartes-training', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'scout-squad.fp.astartes-training') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const candidates = T.friendlies(ev.state, KW).filter((o) => !active || o.id === active.id);
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    effect(ev.state, {
      rule: ASTARTES_TRAINING,
      source: { kind: 'ploy', id: 'scout-squad.fp.astartes-training' },
      sourceText: shortQuote(text('scout-squad.fp.astartes-training')),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfActivation', operativeId: op.id },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Astartes Training: ${op.letter} gains a second Shoot/Fight` });
  });

  // ---- RAW PHYSIOLOGY (firefight, 1CP) -----------------------------------
  // "Until the start of its next activation, add 1" to its Move stat and you can ignore any
  //  changes to that operative's stats from being injured (including its weapons' stats)."
  reg.on('onPloyUsed', T.bind('scout-squad.fp.raw-physiology', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'scout-squad.fp.raw-physiology') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const candidates = T.friendlies(ev.state, KW).filter((o) => !active || o.id === active.id);
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    effect(ev.state, {
      rule: RAW_PHYSIOLOGY,
      source: { kind: 'ploy', id: 'scout-squad.fp.raw-physiology' },
      sourceText: shortQuote(text('scout-squad.fp.raw-physiology')),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
    });
  });
  reg.on('onStatMod', T.bind('scout-squad.fp.raw-physiology', 21), (ev) => {
    if (ev.operative.player !== T.player) return;
    if (!effectOn(ev.state, ev.operative.id, RAW_PHYSIOLOGY)) return;
    ev.mods.move += 1; // "add 1\" to its Move stat"
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2; // cancels the injured -2" Move
    ev.mods.hit += 1; // cancels the injured Hit worsening ("including its weapons' stats")
  });

  // ---- EMBOLDENED ASPIRANT (firefight, 1CP) ------------------------------
  // "Use this firefight ploy when a friendly SCOUT SQUAD operative performs the Shoot or Fight
  //  action, after any re-rolls. If it's the first friendly operative to perform either of
  //  those actions during this turning point, or if the enemy operative in that action
  //  (primary target, if relevant) has a higher Wounds stat than that friendly SCOUT SQUAD
  //  operative, you can retain one of your normal successes as a critical success instead."
  reg.on('onPloyUsed', T.bind('scout-squad.fp.emboldened-aspirant', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'scout-squad.fp.emboldened-aspirant') return;
    const seq = ev.state.sequence;
    if (!seq) return;
    const me = ev.state.operatives[seq.attackerId];
    if (!me || !T.mineKw(me, KW)) return;
    const pool = seq.kind === 'shoot' ? seq.attack : seq.attackerPool;
    const foeId = seq.kind === 'shoot' ? seq.targetId : seq.defenderId;
    const foe = ev.state.operatives[foeId];
    const first = attackOrder(ev.state, T.player)[0] === me.id;
    const tougher = Boolean(foe) && (T.card(foe!)?.wounds ?? 0) > (T.card(me)?.wounds ?? 0);
    if (!first && !tougher) return;
    const die = pool.dice.find((d) => d.state === 'normal');
    if (!die) return;
    die.state = 'crit';
    die.note = 'Emboldened Aspirant';
    log(ev.state, {
      kind: 'dice',
      player: T.player,
      text: `Emboldened Aspirant: ${me.letter} retains a normal success as a critical success`,
    });
  });

  // ---- COVERT POSITION (firefight, 1CP) ----------------------------------
  reg.on('onPloyUsed', T.bind('scout-squad.fp.covert-position', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'scout-squad.fp.covert-position') return;
    const active = ev.state.activeOperativeId ? ev.state.operatives[ev.state.activeOperativeId] : undefined;
    const candidates = T.friendlies(ev.state, KW).filter((o) => !active || o.id === active.id);
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    effect(ev.state, {
      rule: COVERT_POSITION,
      source: { kind: 'ploy', id: 'scout-squad.fp.covert-position' },
      sourceText: shortQuote(text('scout-squad.fp.covert-position')),
      operativeId: op.id,
      player: T.player,
      expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
    });
  });
  // "while that operative has a Conceal order and is in cover, it cannot be selected as a valid
  //  target, taking precedence over all other rules (e.g. Seek, Vantage terrain) except being
  //  within 2"." — cover is therefore recomputed WITHOUT any Seek grant and without Vantage
  //  denying Light cover, and the 2" carve-out is already how core cover works.
  reg.on('onValidTarget', T.bind('scout-squad.fp.covert-position', 25), (ev) => {
    if (!T.ctx) return;
    const target = ev.target;
    if (target.player !== T.player || target.order !== 'conceal') return;
    if (!effectOn(ev.state, target.id, COVERT_POSITION)) return;
    if (T.gap(ev.attacker, target) <= 2 + EPS) return;
    const index = terrain(T.ctx, ev.state);
    if (!coverAndObscured(index, body(T.ctx, ev.attacker), body(T.ctx, target)).inCover) return;
    ev.valid = false;
    ev.reason = 'Covert Position: a Conceal order in cover cannot be selected as a valid target';
  });
}

/** "up to D3 friendly operatives" — the player's list, or a deterministic lowest-id prefix. */
function pickUpTo(
  data: Record<string, unknown> | undefined,
  candidates: OperativeState[],
  max: number,
): OperativeState[] {
  const ids = data?.['operativeIds'];
  if (Array.isArray(ids)) {
    const chosen = candidates.filter((o) => (ids as unknown[]).includes(o.id));
    if (chosen.length > 0) return chosen.slice(0, max);
  }
  const single = data?.['operativeId'];
  if (typeof single === 'string') {
    const one = candidates.find((o) => o.id === single);
    if (one) return [one];
  }
  return [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, max);
}

// ---------------------------------------------------------------------------
// Faction equipment
// ---------------------------------------------------------------------------

/**
 * The COMBAT BLADE equipment's weapon table, read out of `data/teams/scout-squad.json` rather
 * than retyped. The fallback only exists so a re-scrape that drops the parsed weapon block
 * cannot break module load; `scout-squad.test.ts` pins the two against each other.
 */
const COMBAT_BLADE: Weapon = ((): Weapon => {
  const printed = (DATA.equipment.find((e) => e.id === 'scout-squad.eq.combat-blade') as { weapons?: Weapon[] } | undefined)
    ?.weapons?.[0];
  return printed ?? { name: 'Combat blade', profiles: [{ type: 'melee', atk: 3, hit: 3, dmgN: 4, dmgC: 5, rules: [] }] };
})();

const OCULARS_PER_TP = 2;

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // ---- CAMO CLOAK --------------------------------------------------------
  // "Whenever an operative is shooting a friendly SCOUT SQUAD operative (excluding SNIPER), if
  //  you can retain any cover saves, you can retain one additional cover save. This isn't
  //  cumulative with improved cover saves from Vantage terrain."
  reg.on('onDefenceDice', T.bind('scout-squad.eq.camo-cloak', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'scout-squad.eq.camo-cloak')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, KW) || T.kw(target, 'SNIPER')) return;
    if (!ev.coverSave) return;
    const seq = shootSeq(ev.state);
    if (seq?.vantageImprovedCover) return;
    ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
  });

  // ---- TARGETING OCULARS -------------------------------------------------
  // "Up to twice per turning point, when a friendly SCOUT SQUAD operative is performing the
  //  Shoot action and you're selecting a valid target, you can use this rule. If you do, until
  //  the end of that action, that friendly operative's ranged weapons have the Lethal 5+ and
  //  Saturate weapon rules."
  //
  // "You can use this rule" is auto-used on a stated policy (docs/DECISIONS.md D-022): it fires
  // at the Select Valid Target step of a friendly Shoot action, at most twice per turning
  // point, and is skipped when the profile already has both rules (where it would do nothing).
  reg.on('onSelectTarget', T.bind('scout-squad.eq.targeting-oculars', 30), (ev) => {
    if (ev.attacker.player !== T.player) return;
    const live = bucket(ev.state, 'scoutSquad.oculars');
    delete live[ev.attacker.id]; // a new Shoot action — the previous grant is over
    if (!hasEquipment(ev.state, T.player, 'scout-squad.eq.targeting-oculars')) return;
    if (!T.kw(ev.attacker, KW)) return;
    const uses = bucket(ev.state, 'scoutSquad.ocularsUses');
    const key = `${T.player}:${ev.state.turningPoint}`;
    const used = Number((uses[key] ?? 0) as number);
    if (used >= OCULARS_PER_TP) return;
    const already =
      ev.rules.some((r) => r.id === 'Saturate') && ev.rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5);
    if (already) return;
    uses[key] = used + 1;
    live[ev.attacker.id] = true;
    log(ev.state, {
      kind: 'action',
      player: T.player,
      text: `Targeting Oculars: ${ev.attacker.letter}'s ranged weapons have Lethal 5+ and Saturate (${used + 1}/${OCULARS_PER_TP})`,
    });
  });
  reg.on('onWeaponRules', T.bind('scout-squad.eq.targeting-oculars', 31), (ev) => {
    if (ev.type !== 'ranged' || !T.mineKw(ev.operative, KW)) return;
    if (!bucket(ev.state, 'scoutSquad.oculars')[ev.operative.id]) return;
    // "until the end of that action" — only while that Shoot sequence is in flight.
    if (shootSeq(ev.state)?.attackerId !== ev.operative.id) return;
    ev.rules.push(ruleTag('Lethal', 5, 'Lethal 5+ (Targeting Oculars)'));
    ev.rules.push(ruleTag('Saturate', undefined, 'Saturate (Targeting Oculars)'));
  });

  // ---- COMBAT BLADE ------------------------------------------------------
  // "Friendly SCOUT SQUAD operatives have the following melee weapon. Note that some operatives
  //  already have this weapon but with better stats; in that instance, use the better version."
  const giveBlades = (state: GameState): void => {
    if (!hasEquipment(state, T.player, 'scout-squad.eq.combat-blade')) return;
    for (const op of T.friendlies(state, KW)) {
      const carried = T.ctx
        ? weaponsOf(T.ctx, state, op, 'melee').map((w) => w.name)
        : (T.card(op)?.weapons ?? []).map((w) => w.name);
      if (carried.some((n) => n.toLowerCase() === 'combat blade')) continue; // the better version
      grantWeapon(op, structuredClone(COMBAT_BLADE));
    }
  };
  reg.on('onDeploy', T.bind('scout-squad.eq.combat-blade', 30), (ev) => {
    if (ev.operative.player === T.player) giveBlades(ev.state);
  });
  reg.on('onActivationStart', T.bind('scout-squad.eq.combat-blade', 31), (ev) => {
    if (ev.operative.player === T.player) giveBlades(ev.state);
  });

  // ---- TACTICAL VOX-LINK -------------------------------------------------
  // "Once per turning point, you can use the Astartes Training or Emboldened Aspirant firefight
  //  ploy for 0CP if a friendly SERGEANT operative is in the killzone."
  //
  // CP is deducted before `onPloyUsed` fires, so a discount can only be a refund — and every
  // part of this condition is knowable at that moment, so the refund is exact.
  reg.on('onPloyUsed', T.bind('scout-squad.eq.tactical-vox-link', 30), (ev) => {
    if (ev.player !== T.player) return;
    if (ev.ployId !== 'scout-squad.fp.astartes-training' && ev.ployId !== 'scout-squad.fp.emboldened-aspirant') return;
    if (!hasEquipment(ev.state, T.player, 'scout-squad.eq.tactical-vox-link')) return;
    if (!T.friendlies(ev.state).some((o) => T.kw(o, 'SERGEANT'))) return;
    if (!useOncePerTP(ev.state, `scoutSquad.voxLink:${T.player}`)) return;
    const cp = DATA.firefightPloys.find((p) => p.id === ev.ployId)!.cp;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, {
      kind: 'ploy',
      player: T.player,
      text: `Tactical Vox-link: ${DATA.firefightPloys.find((p) => p.id === ev.ployId)!.name} costs 0CP`,
    });
  });
}

// ---------------------------------------------------------------------------
// Unique actions
// ---------------------------------------------------------------------------

function actions(data: typeof DATA) {
  return [
    // OPTICS 1AP — SNIPER
    uniqueAction(data, 'scout-squad.sniper', 'scout-squad.sniper.act.optics', {
      // "This operative cannot perform this action while within control range of an enemy
      //  operative."
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === OPTICS && e.operativeId === op.id);
        effect(state, {
          rule: OPTICS,
          source: { kind: 'ability', id: 'scout-squad.sniper.act.optics' },
          sourceText: shortQuote(actionText('scout-squad.sniper', 'scout-squad.sniper.act.optics')),
          operativeId: op.id,
          player: op.player,
          // "Until the start of this operative's next activation"
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: OPTICS (enemies cannot be obscured)` });
        return { ok: true };
      },
    }),

    // TRACK ENEMY 1AP — TRACKER
    uniqueAction(data, 'scout-squad.tracker', 'scout-squad.tracker.act.track-enemy', {
      // D-026: the whole legality lives here, because `src/ai/legal.ts` offers friendly targets
      // too and only re-runs `check`.
      check: (ctx, state, op, params) => {
        const eng = notEngaged(ctx, state, op);
        if (!eng.ok) return eng;
        const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
        if (!target || target.removed || target.player === op.player)
          return { ok: false, reason: 'select one enemy operative within 8" of this operative' };
        if (gapBetween(ctx, op, target) > 8 + EPS)
          return { ok: false, reason: 'that enemy operative is more than 8" away' };
        return { ok: true };
      },
      perform: (_ctx, state, op, params) => {
        const target = state.operatives[params.targetOperativeId!]!;
        dropEffects(state, (e) => e.rule === TRACK_TOKEN && e.operativeId === target.id && e.player === op.player);
        effect(state, {
          rule: TRACK_TOKEN,
          source: { kind: 'ability', id: 'scout-squad.tracker.act.track-enemy' },
          sourceText: shortQuote(actionText('scout-squad.tracker', 'scout-squad.tracker.act.track-enemy')),
          operativeId: target.id,
          player: op.player,
          // "Until the end of the turning point"
          expiry: { kind: 'endOfTurningPoint' },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: TRACK ENEMY marks ${target.letter}` });
        return { ok: true };
      },
    }),

    // AUSPEX SCAN 1AP — TRACKER
    uniqueAction(data, 'scout-squad.tracker', 'scout-squad.tracker.act.auspex-scan', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        dropEffects(state, (e) => e.rule === SCAN_SOURCE && e.operativeId === op.id);
        effect(state, {
          rule: SCAN_SOURCE,
          source: { kind: 'ability', id: 'scout-squad.tracker.act.auspex-scan' },
          sourceText: shortQuote(actionText('scout-squad.tracker', 'scout-squad.tracker.act.auspex-scan')),
          operativeId: op.id,
          player: op.player,
          // "Until the start of this operative's next activation or until it's incapacitated
          //  (whichever comes first)" — `isScanned` drops it the moment it is incapacitated.
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: AUSPEX SCAN (enemies within 8")` });
        return { ok: true };
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// SERGEANT › Guidance and Experience (a 0AP action, so the player makes the choice)
// ---------------------------------------------------------------------------

/**
 * "Once during each of this operative's activations, you can select one other friendly SCOUT
 * SQUAD operative in the killzone. Until the end of that operative's next activation, add 1 to
 * its APL stat."
 *
 * There is no printed unique action and no AP cost, so it is registered as a 0AP action: the
 * player picks the operative rather than the engine picking one silently, and the universal
 * action restriction ("an operative cannot perform the same action more than once during its
 * activation") is exactly "once during each of this operative's activations".
 */
export const GUIDANCE_ACTION = 'Guidance and Experience';

registerAction({
  id: GUIDANCE_ACTION,
  name: 'Guidance and Experience',
  ap: 0,
  type: 'unique',
  sourceText: abilityText('scout-squad.sergeant', 'scout-squad.sergeant.guidance-and-experience'),
  available: (_ctx, _state, op) => op.datacardId === 'scout-squad.sergeant',
  check(ctx, state, op, params) {
    const target = params.targetOperativeId ? state.operatives[params.targetOperativeId] : undefined;
    if (!target || target.removed || target.player !== op.player || target.id === op.id)
      return { ok: false, reason: 'select one OTHER friendly SCOUT SQUAD operative in the killzone' };
    if (!(ctx.datacards.get(target.datacardId)?.keywords ?? []).includes(KW))
      return { ok: false, reason: 'select one other friendly SCOUT SQUAD operative' };
    return { ok: true };
  },
  perform(_ctx, state, op, params) {
    const target = state.operatives[params.targetOperativeId!]!;
    target.aplMods.push(1);
    effect(state, {
      rule: GUIDANCE_APL,
      source: { kind: 'ability', id: 'scout-squad.sergeant.guidance-and-experience' },
      sourceText: shortQuote(abilityText('scout-squad.sergeant', 'scout-squad.sergeant.guidance-and-experience')),
      operativeId: target.id,
      player: op.player,
      expiry: { kind: 'endOfNextActivation', operativeId: target.id, armed: false },
    });
    log(state, {
      kind: 'action',
      player: op.player,
      text: `${op.letter}: Guidance and Experience — ${target.letter} +1 APL`,
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Astartes / ASTARTES TRAINING: the second Shoot and the second Fight
// ---------------------------------------------------------------------------

/**
 * SERGEANT › Astartes: "During this operative's activation, it can perform either two Shoot
 * actions or two Fight actions. If it's two Shoot actions, an Astartes shotgun, bolt pistol or
 * boltgun must be selected for at least one of them."
 *
 * ASTARTES TRAINING (firefight ploy) grants the same two actions to any friendly SCOUT SQUAD
 * operative, and additionally allows "two Shoot actions with a heavy bolter, missile launcher
 * or sniper rifle, but 1 additional AP must be spent for the second action".
 *
 * Action restrictions forbid repeating an action, so each is its own `ActionDef` that resolves
 * through the universal one (docs/DECISIONS.md D-021, the Angels of Death shape). The ids are
 * team-scoped because `registerAction` is a single global registry and every Astartes kill team
 * needs its own pair.
 */
export const SCOUT_ASTARTES_SHOOT = 'Shoot (Scout Astartes)';
export const SCOUT_ASTARTES_FIGHT = 'Fight (Scout Astartes)';

const ASTARTES_SOURCE_TEXT = abilityText('scout-squad.sergeant', 'scout-squad.sergeant.astartes');

/** Which rule is granting the extra action — the ability, the ploy, or neither. */
function astartesSource(state: GameState, op: OperativeState): 'ability' | 'ploy' | null {
  if (effectOn(state, op.id, ASTARTES_TRAINING)) return 'ploy';
  if (op.datacardId === 'scout-squad.sergeant') return 'ability';
  return null;
}

registerAction({
  id: SCOUT_ASTARTES_SHOOT,
  name: 'Shoot (Scout Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: ASTARTES_SOURCE_TEXT,
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    const source = astartesSource(state, op);
    if (!source)
      return { ok: false, reason: 'only the SERGEANT (Astartes) or the Astartes Training ploy grants a second Shoot' };
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    if (op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '');
    const second = params.weaponName ?? '';
    const light = isLightAstartes(first) || isLightAstartes(second);
    if (!light) {
      if (source !== 'ploy' || !isHeavyAstartes(first) || !isHeavyAstartes(second))
        return { ok: false, reason: 'an Astartes shotgun, bolt pistol or boltgun must be selected for at least one of them' };
      // "1 additional AP must be spent for the second action" — checked here rather than in
      // perform, because the reducer prices the action before perform runs.
      if (op.apSpent + 2 > aplOf(ctx, state, op))
        return { ok: false, reason: '1 additional AP must be spent for the second action' };
    }
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    const first = String(effectOn(state, op.id, LAST_RANGED)?.data?.['weapon'] ?? '');
    const second = params.weaponName ?? '';
    if (!isLightAstartes(first) && !isLightAstartes(second) && isHeavyAstartes(first) && isHeavyAstartes(second))
      op.apSpent += 1;
    return getAction('Shoot')!.perform(ctx, state, op, params);
  },
});

registerAction({
  id: SCOUT_ASTARTES_FIGHT,
  name: 'Fight (Scout Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: ASTARTES_SOURCE_TEXT,
  available: (ctx, _state, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes(KW),
  check(ctx, state, op, params) {
    if (!astartesSource(state, op))
      return { ok: false, reason: 'only the SERGEANT (Astartes) or the Astartes Training ploy grants a second Fight' };
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Astartes is the second Fight action of an activation' };
    if (op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform: (ctx, state, op, params) => getAction('Fight')!.perform(ctx, state, op, params),
});

// ---------------------------------------------------------------------------
// WARRIOR › Adaptive Equipment (the Kommandos "Taktical Wot-notz" shape)
// ---------------------------------------------------------------------------

export const ADAPTIVE_SMOKE = 'Smoke Grenade (Adaptive Equipment)';
export const ADAPTIVE_STUN = 'Stun Grenade (Adaptive Equipment)';

const ADAPTIVE_TEXT = abilityText('scout-squad.warrior', 'scout-squad.warrior.adaptive-equipment');

/** "You can do each of the following once per turning point" — kill-team-wide, per action. */
const adaptiveKey = (player: PlayerId, action: string): string => `scoutSquad.adaptive:${player}:${action}`;

function adaptiveUsedThisTP(state: GameState, player: PlayerId, action: string): boolean {
  return bucket(state, 'teamOnce')[adaptiveKey(player, action)] === `${state.turningPoint}`;
}
function markAdaptive(state: GameState, player: PlayerId, action: string): void {
  bucket(state, 'teamOnce')[adaptiveKey(player, action)] = `${state.turningPoint}`;
}

function adaptiveGrenade(id: string, name: string, delegate: 'Smoke Grenade' | 'Stun Grenade'): void {
  registerAction({
    id,
    name,
    ap: 1,
    type: 'unique',
    sourceText: ADAPTIVE_TEXT,
    available: (_ctx, _state, op) => op.datacardId === 'scout-squad.warrior',
    check(ctx, state, op, params) {
      if (adaptiveUsedThisTP(state, op.player, id))
        return { ok: false, reason: 'you can do each of these once per turning point' };
      // The delegated universal action gets the final say — its perform is what runs, and a
      // perform failure is reverted AND recorded as a rejected intent (D-026).
      return getAction(delegate)!.check(ctx, withGrenadeBudgetIgnored(state, op.player), op, params);
    },
    perform(ctx, state, op, params) {
      // "Performing these actions using this rule doesn't count towards their action limits" —
      // the universal action spends a kill-team grenade use, which is restored afterwards.
      const uses = { ...state.teams[op.player].equipmentUses };
      const res = getAction(delegate)!.perform(ctx, state, op, params);
      state.teams[op.player].equipmentUses = { ...uses };
      if (res.ok) markAdaptive(state, op.player, id);
      return res;
    },
  });
}

adaptiveGrenade(ADAPTIVE_SMOKE, 'Smoke Grenade (Adaptive Equipment)', 'Smoke Grenade');
adaptiveGrenade(ADAPTIVE_STUN, 'Stun Grenade (Adaptive Equipment)', 'Stun Grenade');

// ---------------------------------------------------------------------------

export const scoutSquad = defineTeam({
  id: 'scout-squad',
  rules,
  ploys,
  equipment,
  actions,
  ployUsable: {
    // "You cannot use this ploy during the first turning point."
    'scout-squad.sp.stealth-relocation': (state) =>
      state.turningPoint > 1 ? { ok: true } : { ok: false, reason: 'not during the first turning point' },
  },
  aiHints: {
    roles: {
      'scout-squad.sergeant': 'leader',
      'scout-squad.heavy-gunner': 'gunner',
      'scout-squad.hunter': 'melee',
      'scout-squad.sniper': 'sniper',
      'scout-squad.tracker': 'scout',
      'scout-squad.warrior': 'objective',
    },
    ployValue: {
      'scout-squad.sp.guerrilla-engagement': 0.5,
      'scout-squad.sp.ambush': 0.7,
      'scout-squad.sp.adaptable-training': 0.4,
      'scout-squad.sp.stealth-relocation': 0.4,
      'scout-squad.fp.astartes-training': 0.7,
      'scout-squad.fp.raw-physiology': 0.4,
      'scout-squad.fp.emboldened-aspirant': 0.6,
      'scout-squad.fp.covert-position': 0.5,
    },
    equipmentValue: {
      'scout-squad.eq.camo-cloak': 0.6,
      'scout-squad.eq.targeting-oculars': 0.6,
      'scout-squad.eq.combat-blade': 0.4,
      'scout-squad.eq.tactical-vox-link': 0.3,
    },
  },
});

export default scoutSquad;
