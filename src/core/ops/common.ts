/**
 * Shared op machinery.
 *
 * Approved Ops › Play the battle: "Each player can score a maximum of 6VP from each op."
 * Every op scores through `awardVP`, which enforces that cap, records the per-turning-point
 * breakdown on `TeamState.vpByOp` and emits the `onScore` hook so team rules can see it.
 *
 * Nothing here reads the DOM or does IO; ops mutate the GameState they are handed (the
 * reducer clones before calling).
 */
import { baseGap, baseWhollyWithin, distancePointToSegment } from '../geometry.ts';
import { terrain, type GameContext } from '../context.ts';
import type { OpDef } from '../context.ts';
import { HookRegistry, type RuleBinding } from '../hooks.ts';
import {
  aliveOperatives,
  aplOf,
  body,
  card,
  enemiesInControlRange,
  log,
  markerContestedBy,
  markerController,
} from '../state.ts';
import { coverAndObscured, isVisible } from '../visibility.ts';
import { KILL_OP_TEXT, printedOp } from './text.ts';
import type {
  GameState,
  MarkerState,
  OperativeState,
  PendingDecision,
  PlayerId,
  Poly,
  Vec2,
} from '../types.ts';
import { otherPlayer } from '../types.ts';

export const PLAYERS: PlayerId[] = ['p1', 'p2'];

/** The kill op is always in play — every player scores from crit, kill and tac ops. */
export const KILL_OP_ID = 'kill.killOp';

/**
 * The printed name of an op, falling back to its id if it has no card text.
 *
 * The kill op is not in the crit/tac lists `printedOp` searches — it has its own card — so it
 * is looked up separately rather than surfacing to a player as `kill.killOp`.
 */
export function opLabel(id: string): string {
  if (id === KILL_OP_ID) return KILL_OP_TEXT.name;
  try {
    return printedOp(id).name;
  } catch {
    return id;
  }
}

/** The three ops a player may nominate as their primary op in the first turning point. */
export function primaryOpChoices(state: GameState, player: PlayerId): string[] {
  const ids = [state.critOpId, KILL_OP_ID, state.teams[player].tacOpId];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** "Each player can score a maximum of 6VP from each op." */
export const MAX_VP_PER_OP = 6;

/** `vpByOp[opId][slot]`: slots 0..3 are turning points 1..4, slot 4 is end-of-battle scoring. */
export const END_OF_BATTLE_SLOT = 4;

/**
 * An op with the extra scoring entry points the kernel calls. `OpDef.register` may only
 * install hooks that need no GameContext (hook handlers do not receive one); everything that
 * needs terrain, datacards or dice is done from these methods, which take `ctx`.
 */
export interface OpModule extends OpDef {
  /** Battle setup: place tokens, number markers, flag markers. */
  init?(ctx: GameContext, state: GameState): void;
  /** End of a turning point, per player. */
  scoreEndOfTP?(ctx: GameContext, state: GameState, player: PlayerId): void;
  /** End of the battle, per player. */
  scoreEndOfBattle?(ctx: GameContext, state: GameState, player: PlayerId): void;
  /** Resolve a PendingDecision this op raised. */
  resolveDecision?(
    ctx: GameContext,
    state: GameState,
    decision: PendingDecision,
    optionId: string,
    data?: Record<string, unknown>,
  ): boolean;
}

// ---------------------------------------------------------------------------
// Scratch space
// ---------------------------------------------------------------------------

/** Namespaced, serialisable scratch space on GameState (never module-level state). */
export function opScratch<T extends Record<string, unknown>>(state: GameState, key: string, init: () => T): T {
  const cur = state.opState[key] as T | undefined;
  if (cur) return cur;
  const made = init();
  state.opState[key] = made as unknown as Record<string, unknown>;
  return made;
}

// ---------------------------------------------------------------------------
// Objective markers
// ---------------------------------------------------------------------------

export const objectiveMarkers = (state: GameState): MarkerState[] =>
  Object.values(state.markers).filter((m) => m.kind === 'objective');

/** Which half of the map a player took ("The player with initiative selects one drop zone"). */
export const zoneOf = (state: GameState, player: PlayerId): 'p1' | 'p2' =>
  state.setup.dropZone[player] ?? player;

export const territoryOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.territories[zoneOf(state, player)] ?? [];

export const dropZoneOf = (state: GameState, player: PlayerId): Poly[] =>
  state.map.dropZones[zoneOf(state, player)] ?? [];

/** The map card's side for an objective marker: player 1's, player 2's or the centre one. */
export function objectiveSide(state: GameState, marker: MarkerState): 'p1' | 'p2' | 'centre' {
  return state.map.objectives.find((o) => o.id === marker.id)?.kind ?? 'centre';
}

/** Whose objective marker is it, once drop zones are chosen? `null` = the centre marker. */
export function objectiveOwner(state: GameState, marker: MarkerState): PlayerId | null {
  const side = objectiveSide(state, marker);
  if (side === 'centre') return null;
  return PLAYERS.find((p) => zoneOf(state, p) === side) ?? null;
}

export function contestedByPlayer(
  ctx: GameContext,
  state: GameState,
  marker: MarkerState,
  player: PlayerId,
): boolean {
  return aliveOperatives(state, player).some((o) => markerContestedBy(ctx, state, marker, o));
}

/** "One objective marker the active operative controls" — it contests it and its team controls it. */
export function activeControls(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  marker: MarkerState,
): boolean {
  return markerContestedBy(ctx, state, marker, op) && markerController(ctx, state, marker) === op.player;
}

export function controlledObjectives(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  filter?: (m: MarkerState) => boolean,
): MarkerState[] {
  return objectiveMarkers(state).filter(
    (m) => (!filter || filter(m)) && markerController(ctx, state, m) === player,
  );
}

// ---------------------------------------------------------------------------
// Victory points
// ---------------------------------------------------------------------------

function vpSlots(state: GameState, player: PlayerId, opId: string): number[] {
  const team = state.teams[player];
  const arr = team.vpByOp[opId] ?? [];
  while (arr.length <= END_OF_BATTLE_SLOT) arr.push(0);
  team.vpByOp[opId] = arr;
  return arr;
}

export function vpFromOp(state: GameState, player: PlayerId, opId: string): number {
  return (state.teams[player].vpByOp[opId] ?? []).reduce((a, b) => a + b, 0);
}

export function vpFromOpThisTP(state: GameState, player: PlayerId, opId: string): number {
  const arr = state.teams[player].vpByOp[opId] ?? [];
  return arr[Math.max(0, state.turningPoint - 1)] ?? 0;
}

/** How much more this op may score this turning point under its own per-TP cap. */
export function roomThisTP(state: GameState, player: PlayerId, opId: string, cap: number): number {
  return Math.max(0, cap - vpFromOpThisTP(state, player, opId));
}

/**
 * Score VP for an op, capped at 6VP per op for the battle. Returns the VP actually scored.
 * `slot` defaults to the current turning point; end-of-battle scoring passes END_OF_BATTLE_SLOT.
 */
export function awardVP(
  ctx: GameContext,
  state: GameState,
  player: PlayerId,
  opId: string,
  vp: number,
  note: string,
  slot = Math.max(0, state.turningPoint - 1),
): number {
  if (vp <= 0) return 0;
  const slots = vpSlots(state, player, opId);
  const already = slots.reduce((a, b) => a + b, 0);
  const room = MAX_VP_PER_OP - already;
  if (room <= 0) {
    log(state, { kind: 'score', player, text: `${note} — no VP (${opId} is capped at ${MAX_VP_PER_OP}VP)` });
    return 0;
  }
  const ev = ctx.hooks.emit('onScore', state, { state, player, opId, vp: Math.min(vp, room) });
  const granted = Math.max(0, Math.min(ev.vp, room));
  if (granted <= 0) return 0;
  slots[slot] = (slots[slot] ?? 0) + granted;
  state.teams[player].vp += granted;
  log(state, {
    kind: 'score',
    player,
    text: `${note} — ${granted}VP`,
    data: { opId, vp: granted, slot },
  });
  return granted;
}

// ---------------------------------------------------------------------------
// Kill records
// ---------------------------------------------------------------------------

/**
 * What ops need to know about an incapacitation, captured when it happens (the
 * `onIncapacitated` hook gives no GameContext, so only ids/positions are recorded here and
 * everything else — Wounds stats, control range — is worked out at scoring time).
 */
export interface KillRecord {
  key: string;
  tp: number;
  victimId: string;
  victimPlayer: PlayerId;
  victimPos: Vec2;
  victimZ: number;
  killerId?: string;
  killerPlayer?: PlayerId;
  killerPos?: Vec2;
}

interface KillLog extends Record<string, unknown> {
  list: KillRecord[];
  seen: string[];
}

const killLog = (state: GameState): KillLog =>
  opScratch<KillLog>(state, 'ops.kills', () => ({ list: [], seen: [] }));

export const killRecords = (state: GameState): KillRecord[] => killLog(state).list;

export const killRecordsInTP = (state: GameState, tp: number): KillRecord[] =>
  killRecords(state).filter((k) => k.tp === tp);

/** Who is dealing the damage right now, if a shoot/fight sequence is in flight? */
function killerOf(state: GameState, victimId: string): OperativeState | undefined {
  const seq = state.sequence;
  if (!seq) return undefined;
  if (seq.kind === 'fight') {
    const id = seq.attackerId === victimId ? seq.defenderId : seq.attackerId;
    return state.operatives[id];
  }
  return state.operatives[seq.attackerId];
}

/** Record an incapacitation. Idempotent: several ops register the same recorder. */
export function recordIncapacitation(state: GameState, victim: OperativeState): void {
  const logged = killLog(state);
  const key = `${victim.id}@${state.seq}`;
  if (logged.seen.includes(key)) return;
  // Guard against a re-record of the same death from the end-of-TP reconciliation.
  if (logged.list.some((k) => k.victimId === victim.id && k.tp === state.turningPoint)) return;
  logged.seen.push(key);
  const killer = killerOf(state, victim.id);
  logged.list.push({
    key,
    tp: state.turningPoint,
    victimId: victim.id,
    victimPlayer: victim.player,
    victimPos: { ...victim.pos },
    victimZ: victim.z,
    ...(killer && killer.player !== victim.player
      ? { killerId: killer.id, killerPlayer: killer.player, killerPos: { ...killer.pos } }
      : {}),
  });
}

/**
 * Reconciliation for setups that do not emit `onIncapacitated` (or rules that remove an
 * operative some other way): make sure every removed operative has a record. Kills found this
 * way have no killer, so kill-op counting works but Rout/Dominate cannot score from them.
 */
export function syncKillRecords(state: GameState): void {
  const logged = killLog(state);
  for (const op of Object.values(state.operatives)) {
    if (!op.removed && !op.incapacitated) continue;
    if (logged.list.some((k) => k.victimId === op.id)) continue;
    logged.list.push({
      key: `${op.id}@sync${state.seq}`,
      tp: state.turningPoint,
      victimId: op.id,
      victimPlayer: op.player,
      victimPos: { ...op.pos },
      victimZ: op.z,
    });
  }
}

// ---------------------------------------------------------------------------
// Tac op reveal
// ---------------------------------------------------------------------------

interface TacOpScratch extends Record<string, unknown> {
  revealedTP: number;
  reason: string;
}

export const tacOpScratch = (state: GameState, player: PlayerId): TacOpScratch =>
  opScratch<TacOpScratch>(state, `tacop.${player}`, () => ({ revealedTP: 0, reason: '' }));

export function revealTacOp(state: GameState, player: PlayerId, reason: string): void {
  const s = tacOpScratch(state, player);
  if (s.revealedTP > 0) return;
  s.revealedTP = state.turningPoint;
  s.reason = reason;
  log(state, {
    kind: 'system',
    player,
    text: `Tac op revealed (${state.teams[player].tacOpId ?? '?'}): ${reason}`,
  });
}

export const isTacOpRevealed = (state: GameState, player: PlayerId): boolean =>
  tacOpScratch(state, player).revealedTP > 0;

// ---------------------------------------------------------------------------
// "Ignored for the kill op"
// ---------------------------------------------------------------------------

/**
 * Some kill teams' rules say an operative is "ignored for the kill op" (and Envoy may not
 * select one). Team modules mark them with an `ignoredForKillOp` effect; a datacard may also
 * carry the keyword.
 */
export function ignoredForKillOp(ctx: GameContext, state: GameState, op: OperativeState): boolean {
  if (state.effects.some((e) => e.rule === 'ignoredForKillOp' && e.operativeId === op.id)) return true;
  const dc = ctx.datacards.get(op.datacardId);
  return dc?.keywords.some((k) => k.toUpperCase().replace(/[^A-Z]/g, '') === 'IGNOREDFORKILLOP') ?? false;
}

/** Enemy operatives that count for the kill op: the whole starting roster minus ignored ones. */
export function killOpStartingSize(ctx: GameContext, state: GameState, player: PlayerId): number {
  return state.teams[player].operativeIds.filter((id) => {
    const op = state.operatives[id];
    return op ? !ignoredForKillOp(ctx, state, op) : false;
  }).length;
}

// ---------------------------------------------------------------------------
// Positional helpers
// ---------------------------------------------------------------------------

export function whollyWithin(ctx: GameContext, op: OperativeState, polys: Poly[]): boolean {
  if (polys.length === 0) return false;
  return baseWhollyWithin(op.pos, card(ctx, op).base, op.rot, polys);
}

export function markerWhollyWithin(marker: MarkerState, polys: Poly[]): boolean {
  if (polys.length === 0) return false;
  return baseWhollyWithin(marker.pos, { shape: 'round', mm: marker.diameterMm }, 0, polys);
}

export function gapToMarker(ctx: GameContext, op: OperativeState, marker: MarkerState): number {
  return baseGap(op.pos, card(ctx, op).base, op.rot, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0);
}

export function distanceToSegments(p: Vec2, segments: { a: Vec2; b: Vec2 }[]): number {
  let best = Infinity;
  for (const s of segments) best = Math.min(best, distancePointToSegment(p, s.a, s.b));
  return best;
}

/**
 * Core rules › Select Valid Target: "If the intended target has an Engage order, it's a valid
 * target if it's visible to the active operative. If it has a Conceal order, it's a valid
 * target if it's visible to and not in cover from the active operative."
 */
export function isValidTargetFor(
  ctx: GameContext,
  state: GameState,
  watcher: OperativeState,
  target: OperativeState,
): boolean {
  if (watcher.removed || target.removed) return false;
  const index = terrain(ctx, state);
  const a = body(ctx, watcher);
  const t = body(ctx, target);
  if (!isVisible(index, a, t).visible) return false;
  if (target.order === 'conceal' && coverAndObscured(index, a, t).inCover) return false;
  return true;
}

export const isEngagedWithEnemy = (ctx: GameContext, state: GameState, op: OperativeState): boolean =>
  enemiesInControlRange(ctx, state, op).length > 0;

export function totalApl(ctx: GameContext, state: GameState, ops: OperativeState[]): number {
  return ops.reduce((sum, o) => sum + aplOf(ctx, state, o), 0);
}

export const enemyOf = otherPlayer;

// ---------------------------------------------------------------------------
// Mission-action guards shared by every op
// ---------------------------------------------------------------------------

export interface MissionActionOpts {
  /** Earliest turning point the action may be performed in (most ops: 2). */
  fromTP?: number;
}

export function missionActionCheck(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  opts: MissionActionOpts = {},
): { ok: boolean; reason?: string } {
  const from = opts.fromTP ?? 2;
  if (state.turningPoint < from)
    return {
      ok: false,
      reason:
        from === 3
          ? 'cannot be performed during the first or second turning point'
          : 'cannot be performed during the first turning point',
    };
  if (isEngagedWithEnemy(ctx, state, op))
    return { ok: false, reason: 'within control range of an enemy operative' };
  return { ok: true };
}

/** The objective marker an operative-targeted mission action refers to. */
export function targetObjective(
  state: GameState,
  markerId: string | undefined,
): MarkerState | undefined {
  if (!markerId) return undefined;
  const m = state.markers[markerId];
  return m && m.kind === 'objective' ? m : undefined;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Push a PendingDecision unless one with the same (deterministic) id is already pending. */
export function pushOpDecision(state: GameState, decision: PendingDecision): void {
  if (state.pending.some((d) => d.id === decision.id)) return;
  state.pending.push(decision);
  log(state, { kind: 'decision', player: decision.who, text: decision.prompt });
}

// ---------------------------------------------------------------------------
// Registration helpers
// ---------------------------------------------------------------------------

export function binding(id: string, sourceText: string, player: PlayerId, priority = 40): RuleBinding {
  return { id, sourceText, player, priority };
}

/**
 * Hooks every op installs: the kill recorder (so Rout/Dominate/Martyrs/Sweep & Clear and the
 * kill op know who did what) and the secret TP1 primary-op selection. Both are idempotent, so
 * it does not matter that several ops (and both players' registrations) install them.
 */
export function registerSharedOpHooks(reg: HookRegistry, player: PlayerId): void {
  reg.on(
    'onIncapacitated',
    binding('ops.killRecorder', 'Kill records for the kill op and the Seek & Destroy tac ops.', player, 5),
    (ev) => {
      if (ev.prevented) return;
      recordIncapacitation(ev.state, ev.operative);
    },
  );
  reg.on(
    'onReadyStep',
    binding(
      'ops.primaryOp',
      'As a STRATEGIC GAMBIT in the first turning point, each player secretly selects one of their three ops (1.crit, 2.kill or 3.tac) to be their primary op.',
      player,
      5,
    ),
    (ev, b) => {
      if (b.player !== ev.player) return;
      if (ev.state.turningPoint !== 1) return;
      if (ev.state.teams[ev.player].primaryOpId) return;
      const options = primaryOpChoices(ev.state, ev.player);
      if (options.length === 0) return;
      pushOpDecision(ev.state, {
        id: `primaryOp-${ev.player}`,
        who: ev.player,
        kind: 'primaryOp',
        prompt: 'Secretly select your primary op (crit, kill or tac)',
        sourceText:
          'At the end of the battle, the players reveal their primary ops simultaneously. They score additional VP equal to half of what they scored from that op (rounding up).',
        // The printed name, not the internal id: `kill.killOp` is not a thing a player
        // recognises, and this is the one decision where the option IS the whole choice.
        options: options.map((id) => ({ id, label: opLabel(id) })),
      });
    },
  );
}
