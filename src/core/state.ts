/**
 * State queries and small mutators shared by every action/sequence.
 * Everything here is pure w.r.t. the outside world; it may mutate the GameState passed in
 * (the reducer clones before calling).
 */
import { baseGap } from './geometry.ts';
import { zeroStatMods, type StatMods } from './hooks.ts';
import { terrain, type GameContext } from './context.ts';
import { surfaceAt } from './terrain.ts';
import { withinControlRange, type Body } from './visibility.ts';
import type {
  ActiveEffect,
  Datacard,
  GameState,
  LogEntry,
  MarkerState,
  OperativeState,
  PlayerId,
  Weapon,
  WeaponProfile,
} from './types.ts';
import { otherPlayer } from './types.ts';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function card(ctx: GameContext, op: OperativeState): Datacard {
  const c = ctx.datacards.get(op.datacardId);
  if (!c) throw new Error(`Unknown datacard '${op.datacardId}' for operative ${op.id}`);
  return c;
}

/**
 * Model heights by base class. The rules use the miniature's HEAD for visibility, so this
 * matters. Values are assumptions recorded in docs/DECISIONS.md (D-005) and are data, not
 * magic numbers baked into rules.
 */
export const MODEL_HEIGHT_BY_BASE: { maxMm: number; height: number }[] = [
  { maxMm: 25, height: 1.3 },
  { maxMm: 28, height: 1.35 },
  { maxMm: 32, height: 1.6 },
  { maxMm: 40, height: 1.9 },
  { maxMm: 50, height: 2.2 },
  { maxMm: 1000, height: 2.5 },
];

export function modelHeight(c: Datacard): number {
  if (c.height !== undefined) return c.height;
  const mm = c.base.shape === 'round' ? c.base.mm : Math.max(c.base.mm[0], c.base.mm[1]);
  return MODEL_HEIGHT_BY_BASE.find((r) => mm <= r.maxMm)!.height;
}

export function body(ctx: GameContext, op: OperativeState): Body {
  const c = card(ctx, op);
  return { id: op.id, pos: op.pos, z: op.z, rot: op.rot, base: c.base, height: modelHeight(c) };
}

export const aliveOperatives = (state: GameState, player?: PlayerId): OperativeState[] =>
  Object.values(state.operatives).filter((o) => !o.removed && (player === undefined || o.player === player));

export const operative = (state: GameState, id: string): OperativeState | undefined => state.operatives[id];

export function requireOperative(state: GameState, id: string): OperativeState {
  const op = state.operatives[id];
  if (!op) throw new Error(`Unknown operative '${id}'`);
  return op;
}

// ---------------------------------------------------------------------------
// Stats with modifiers
// ---------------------------------------------------------------------------

/**
 * Core rules › Datacards: "Regardless of how many APL stat changes an operative is affected
 * by, the total can never be more than -1 or +1 from its normal APL."
 */
export function aplOf(ctx: GameContext, state: GameState, op: OperativeState): number {
  const base = card(ctx, op).apl;
  // Both sources count toward the same clamp: tokens/effects recorded on the operative, and
  // rules that adjust APL through the onStatMod hook (which was previously ignored here,
  // leaving StatMods.apl dead).
  const raw = op.aplMods.reduce((a, b) => a + b, 0) + statMods(ctx, state, op).apl;
  const clamped = Math.max(-1, Math.min(1, raw));
  return Math.max(0, base + clamped);
}

/**
 * "Subtract 2" from the Move stat of injured operatives" and "An operative's Move stat can
 * never be changed to less than 4"."
 */
export function moveOf(ctx: GameContext, state: GameState, op: OperativeState): number {
  const c = card(ctx, op);
  const mods = statMods(ctx, state, op);
  let m = c.move + mods.move;
  if (isInjured(ctx, op)) m -= 2;
  return Math.max(4, m);
}

export function saveOf(ctx: GameContext, state: GameState, op: OperativeState): number {
  const mods = statMods(ctx, state, op);
  // Improving a Save stat lowers the number; clamp to 2+ .. 6+.
  return Math.max(2, Math.min(6, card(ctx, op).save - mods.save));
}

/** Hit stat for a profile, including injured (-1) and hook modifiers. */
export function hitOf(
  ctx: GameContext,
  state: GameState,
  op: OperativeState,
  profile: WeaponProfile,
  extraHitMod = 0,
): number {
  const mods = statMods(ctx, state, op);
  let hit = profile.hit - mods.hit - extraHitMod;
  if (isInjured(ctx, op)) hit += 1; // "worsen the Hit stat of their weapons by 1"
  return Math.max(2, Math.min(6, hit));
}

export function statMods(ctx: GameContext, state: GameState, op: OperativeState): StatMods {
  const ev = ctx.hooks.emit('onStatMod', state, { state, operative: op, mods: zeroStatMods() });
  return ev.mods;
}

export function startingWounds(ctx: GameContext, op: OperativeState): number {
  return card(ctx, op).wounds;
}

export const isWounded = (ctx: GameContext, op: OperativeState): boolean => op.wounds < startingWounds(ctx, op);

/** "While it has fewer than half its starting wounds remaining, it's also injured." */
export const isInjured = (ctx: GameContext, op: OperativeState): boolean =>
  op.wounds < startingWounds(ctx, op) / 2;

// ---------------------------------------------------------------------------
// Positional queries
// ---------------------------------------------------------------------------

export function gapBetween(ctx: GameContext, a: OperativeState, b: OperativeState): number {
  const ca = card(ctx, a);
  const cb = card(ctx, b);
  return baseGap(a.pos, ca.base, a.rot, b.pos, cb.base, b.rot);
}

export function inControlRange(ctx: GameContext, state: GameState, a: OperativeState, b: OperativeState): boolean {
  if (a.removed || b.removed) return false;
  // Tomb World teleport pad: operatives touching an occupied pad are treated as being
  // within each other's control range.
  if (a.onTeleportPadId && b.onTeleportPadId && a.onTeleportPadId === b.onTeleportPadId) return true;
  return withinControlRange(terrain(ctx, state), body(ctx, a), body(ctx, b));
}

export function enemiesInControlRange(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, otherPlayer(op.player)).filter((e) => inControlRange(ctx, state, op, e));
}

export function friendliesInControlRange(ctx: GameContext, state: GameState, op: OperativeState): OperativeState[] {
  return aliveOperatives(state, op.player).filter((f) => f.id !== op.id && inControlRange(ctx, state, op, f));
}

export const isEngaged = (ctx: GameContext, state: GameState, op: OperativeState): boolean =>
  enemiesInControlRange(ctx, state, op).length > 0;

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

/**
 * The weapons the roster builder recorded for this operative, if any.
 *
 * The selection rules let an operative take "one of the following options", so a datacard
 * lists more weapons than any single operative carries. Core reads the choice straight out
 * of `state.opState.loadout` rather than importing anything from `src/teams/` — the kernel
 * stays faction-agnostic.
 */
function chosenLoadout(state: GameState, op: OperativeState): string[] | undefined {
  const store = state.opState['loadout'] as Record<string, string[]> | undefined;
  const names = store?.[op.id];
  return names && names.length > 0 ? names : undefined;
}

const sameWeaponName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function weaponsOf(ctx: GameContext, state: GameState, op: OperativeState, type?: 'ranged' | 'melee'): Weapon[] {
  const c = card(ctx, op);
  const names = ctx.hooks.emit('availableWeapons', state, {
    state,
    operative: op,
    weapons: c.weapons.map((w) => w.name),
  }).weapons;
  const extra = (op as OperativeState & { grantedWeapons?: Weapon[] }).grantedWeapons ?? [];
  const fromCard = c.weapons.filter((w) => names.includes(w.name));
  const loadout = chosenLoadout(state, op);
  let carried = fromCard;
  if (loadout) {
    const picked = fromCard.filter((w) => loadout.some((n) => sameWeaponName(n, w.name)));
    // Never disarm an operative: if a recorded loadout matches nothing on the card (stale
    // save, renamed weapon), fall back to the full card rather than sending it in unarmed.
    carried = picked.length > 0 ? picked : fromCard;
  }
  const all = [...carried, ...extra];
  if (!type) return all;
  return all.filter((w) => w.profiles.some((p) => p.type === type));
}

export function findProfile(w: Weapon, profileName?: string): WeaponProfile | undefined {
  if (!profileName) return w.profiles[0];
  return w.profiles.find((p) => (p.name ?? '') === profileName) ?? w.profiles[0];
}

/** Limited x: "After an operative uses this weapon x times in the battle, they no longer have it." */
export function weaponExhausted(op: OperativeState, w: Weapon, profile: WeaponProfile): boolean {
  const limited = profile.rules.find((r) => r.id === 'Limited');
  if (!limited) return false;
  const used = op.weaponUses[w.name] ?? 0;
  return used >= (limited.x ?? 1);
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

export function markersNear(ctx: GameContext, state: GameState, op: OperativeState): MarkerState[] {
  return Object.values(state.markers).filter((m) => markerContestedBy(ctx, state, m, op));
}

/** "Operatives contest markers within their control range." */
export function markerContestedBy(
  ctx: GameContext,
  state: GameState,
  marker: MarkerState,
  op: OperativeState,
): boolean {
  if (marker.carriedBy) return marker.carriedBy === op.id;
  const c = card(ctx, op);
  const gap = baseGap(op.pos, c.base, op.rot, marker.pos, { shape: 'round', mm: marker.diameterMm }, 0);
  if (gap > 1 + 1e-6) return false;
  const idx = terrain(ctx, state);
  const markerBody: Body = {
    id: marker.id,
    pos: marker.pos,
    z: marker.z,
    rot: 0,
    base: { shape: 'round', mm: marker.diameterMm },
    height: 0.2,
  };
  return withinControlRange(idx, body(ctx, op), markerBody);
}

/**
 * "Friendly operatives control a marker if the total APL of those contesting it is greater
 * than that of enemy operatives... While an operative is carrying a marker it contests and
 * controls that marker, and is the only operative that can."
 */
export function markerController(ctx: GameContext, state: GameState, marker: MarkerState): PlayerId | null {
  if (marker.carriedBy) {
    const carrier = state.operatives[marker.carriedBy];
    return carrier && !carrier.removed ? carrier.player : null;
  }
  const apl: Record<PlayerId, number> = { p1: 0, p2: 0 };
  for (const op of aliveOperatives(state)) {
    if (markerContestedBy(ctx, state, marker, op)) apl[op.player] += aplOf(ctx, state, op);
  }
  const ev = ctx.hooks.emit('onMarkerControl', state, { state, markerId: marker.id, aplByPlayer: apl });
  if (ev.forced) return ev.forced;
  if (ev.aplByPlayer.p1 > ev.aplByPlayer.p2) return 'p1';
  if (ev.aplByPlayer.p2 > ev.aplByPlayer.p1) return 'p2';
  return null;
}

// ---------------------------------------------------------------------------
// Effects & log
// ---------------------------------------------------------------------------

export function addEffect(state: GameState, effect: Omit<ActiveEffect, 'id'>): ActiveEffect {
  const e: ActiveEffect = { ...effect, id: `eff${state.seq++}` };
  state.effects.push(e);
  return e;
}

export function removeEffects(state: GameState, pred: (e: ActiveEffect) => boolean): void {
  state.effects = state.effects.filter((e) => !pred(e));
}

export function log(state: GameState, entry: Omit<LogEntry, 'seq' | 'tp'>): void {
  state.log.push({ ...entry, seq: state.seq++, tp: state.turningPoint });
}

export function reject(state: GameState, intent: unknown, reason: string): void {
  state.rejected.push({ intent, reason, seq: state.seq });
  log(state, { kind: 'reject', text: reason, data: { intent: intent as Record<string, unknown> } });
}

export function recordRoll(state: GameState, kind: string, results: number[], player?: PlayerId, note?: string): void {
  state.rolls.push({ seq: state.seq++, kind, results, ...(player ? { player } : {}), ...(note ? { note } : {}) });
}

/** Snap an operative to the terrain surface beneath it. */
export function settleZ(ctx: GameContext, state: GameState, op: OperativeState): void {
  op.z = surfaceAt(terrain(ctx, state), op.pos);
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

export interface DamageResult {
  inflicted: number;
  incapacitated: boolean;
}

export function inflictDamage(
  ctx: GameContext,
  state: GameState,
  target: OperativeState,
  amount: number,
  kind: 'attack' | 'mortal' | 'devastating' | 'hazard' | 'mine' | 'other' = 'attack',
): DamageResult {
  const ev = ctx.hooks.emit('onDamage', state, { state, ctx: null, target, amount, kind });
  const dmg = Math.max(0, Math.round(ev.amount));
  target.wounds -= dmg;
  log(state, {
    kind: 'action',
    player: target.player,
    text: `${target.name} takes ${dmg} damage (${target.wounds} wounds left)`,
    data: { operativeId: target.id, damage: dmg, kind },
  });
  if (target.wounds <= 0 && !target.incapacitated) {
    target.incapacitated = true;
    const inc = ctx.hooks.emit('onIncapacitated', state, {
      state,
      operative: target,
      prevented: false,
      freeActions: [],
    });
    if (inc.prevented) {
      target.incapacitated = false;
      if (target.wounds <= 0) target.wounds = 1;
      return { inflicted: dmg, incapacitated: false };
    }
    log(state, { kind: 'action', player: target.player, text: `${target.name} is incapacitated` });
    return { inflicted: dmg, incapacitated: true };
  }
  return { inflicted: dmg, incapacitated: false };
}

/**
 * "Any operatives that were incapacitated are removed after the active operative has
 * finished the action." Carrying operatives must Place Marker first (0AP, forced).
 */
export function removeIncapacitated(ctx: GameContext, state: GameState): void {
  for (const op of Object.values(state.operatives)) {
    if (!op.incapacitated || op.removed) continue;
    if (op.carryingMarkerId) {
      const marker = state.markers[op.carryingMarkerId];
      if (marker) {
        marker.carriedBy = undefined as unknown as string | undefined;
        marker.pos = { ...op.pos };
        marker.z = op.z;
        log(state, {
          kind: 'action',
          player: op.player,
          text: `${op.name} places the ${marker.kind} marker before being removed (0AP)`,
        });
      }
      op.carryingMarkerId = undefined as unknown as string | undefined;
    }
    op.removed = true;
    op.ready = false;
    op.onGuard = false;
    log(state, { kind: 'action', player: op.player, text: `${op.name} is removed from the killzone` });
  }
}

export const teamOf = (state: GameState, player: PlayerId) => state.teams[player];
