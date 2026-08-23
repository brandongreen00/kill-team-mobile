/**
 * Visibility, targeting lines, cover and obscured.
 *
 * Core rules › Visible: "look from behind the operative and determine if you can draw an
 * unobstructed straight line 1mm in diameter from its head to any part of what it's trying
 * to see. Ignore operatives' bases when determining this."
 * Core rules › Intervening: "draw imaginary straight lines 1mm in diameter from any point
 * of its base to every facing part of the intended target's base. Anything at least one of
 * these lines cross is intervening. Anything all of these lines cross is wholly intervening."
 * Core rules › Cover: "in cover if there's intervening terrain within its control range.
 * However, it cannot be in cover while within 2" of the other operative."
 * Core rules › Obscured: "obscured if there's intervening Heavy terrain. However, it cannot
 * be obscured by intervening Heavy terrain that's within 1" of either operative."
 */
import {
  baseGap,
  basePerimeter,
  dist,
  distancePointToPoly,
  pointInPoly,
  segmentCrossesPoly,
  segmentIntersectsPrism,
  sub,
  dot,
  v2,
} from './geometry.ts';
import {
  baseDistanceToPart,
  hasType,
  segmentMayHitPart,
  shooterHasPassed,
  wallCornerZones,
  type IndexedPart,
  type TerrainIndex,
  partsSupporting,
} from './terrain.ts';
import type { BaseShape, Poly, Vec2, Vec3 } from './types.ts';

/** Anything that occupies space and can see / be seen. */
export interface Body {
  id: string;
  pos: Vec2;
  /** Elevation of the feet. */
  z: number;
  rot: number;
  base: BaseShape;
  /** Miniature height in inches (docs/DECISIONS.md D-005). */
  height: number;
}

/** Walls block visibility "over or through", i.e. regardless of their modelled height. */
const WALL_VIRTUAL_TOP = 1000;

export interface VisibilityResult {
  visible: boolean;
  /** The first part that blocked every sampled line (best-effort, for the UI explainer). */
  blockedBy?: IndexedPart;
  /** How many of the sampled lines were unobstructed. */
  clearLines: number;
  totalLines: number;
}

function bodyRadius(b: Body): number {
  // The miniature sits within its base; sample slightly inside so a line that grazes the
  // base edge does not count as seeing the model.
  const { base } = b;
  const mm = base.shape === 'round' ? base.mm : Math.min(base.mm[0], base.mm[1]);
  return (mm / 25.4 / 2) * 0.8;
}

export function headPoint(b: Body): Vec3 {
  return { x: b.pos.x, y: b.pos.y, z: b.z + b.height };
}

/** Silhouette samples on the target miniature (never its base). */
export function silhouetteSamples(b: Body, rings = 4, perRing = 10): Vec3[] {
  const r = bodyRadius(b);
  const out: Vec3[] = [];
  // Skip the very bottom: the base itself is not part of the miniature.
  const z0 = b.z + Math.min(0.12, b.height * 0.15);
  for (let i = 0; i < rings; i++) {
    const z = z0 + ((b.height - (z0 - b.z)) * i) / Math.max(1, rings - 1);
    for (let k = 0; k < perRing; k++) {
      const t = (2 * Math.PI * k) / perRing;
      out.push({ x: b.pos.x + r * Math.cos(t), y: b.pos.y + r * Math.sin(t), z });
    }
    out.push({ x: b.pos.x, y: b.pos.y, z });
  }
  out.push({ x: b.pos.x, y: b.pos.y, z: b.z + b.height });
  return out;
}

interface VisibilityOpts {
  /** Parts to ignore (e.g. the terrain the shooter is standing on). */
  ignore?: (part: IndexedPart) => boolean;
  /** Control-range checks ignore the door and parts under 2" (Volkus stronghold/large ruin). */
  forControlRange?: boolean;
  rings?: number;
  perRing?: number;
}

function partBlocksLine(
  part: IndexedPart,
  from: Vec3,
  to: Vec3,
  fromBody: Body,
  toBody: Body,
): boolean {
  if (!part.blocksVisibility) return false;
  const z1 = hasType(part, 'Wall') ? WALL_VIRTUAL_TOP : part.z1;
  // Barred terrain: "Visibility cannot be drawn through this terrain unless the operative
  // or what they're trying to see is horizontally within 1" of it."
  if (hasType(part, 'Barred')) {
    const near =
      distancePointToPoly(fromBody.pos, part.poly) <= 1 + 1e-6 ||
      distancePointToPoly(toBody.pos, part.poly) <= 1 + 1e-6;
    if (near) return false;
  }
  return segmentIntersectsPrism(from, to, part.poly, part.z0, z1);
}

/**
 * Can `from` see `to`? True if ANY sampled head-to-silhouette line is unobstructed.
 * "An operative is always visible to itself."
 */
export function isVisible(index: TerrainIndex, from: Body, to: Body, opts: VisibilityOpts = {}): VisibilityResult {
  if (from.id === to.id) return { visible: true, clearLines: 1, totalLines: 1 };
  const head = headPoint(from);
  const samples = silhouetteSamples(to, opts.rings ?? 4, opts.perRing ?? 10);
  const candidates = index.parts.filter((p) => {
    if (!p.blocksVisibility) return false;
    if (opts.ignore?.(p)) return false;
    if (opts.forControlRange && controlRangeIgnores(p)) return false;
    return segmentMayHitPart(p, from.pos, to.pos);
  });
  let clear = 0;
  let blocker: IndexedPart | undefined;
  for (const s of samples) {
    let blocked = false;
    for (const part of candidates) {
      if (partBlocksLine(part, head, s, from, to)) {
        blocked = true;
        blocker ??= part;
        break;
      }
    }
    if (!blocked) {
      clear++;
      // Early exit: one clear line is enough.
      return { visible: true, clearLines: clear, totalLines: samples.length };
    }
  }
  return { visible: false, ...(blocker ? { blockedBy: blocker } : {}), clearLines: 0, totalLines: samples.length };
}

/**
 * Control range: "visible to and within 1"". Mutual.
 * Distances between operatives are base-to-base.
 */
/**
 * Terrain the Volkus killzone tells you to look past when working out control range.
 *
 * Killzones § Stronghold: "For the purposes of control range, ignore the door and parts of
 * this terrain feature less than 2" high when determining visibility."
 * Killzones § Large Ruin: "The door is Accessible and Heavy terrain. For the purposes of
 * control range, ignore the door when determining visibility."
 *
 * Two things were wrong with the old test, `p.z1 - p.z0 < 2 && !hasType(p, 'Wall')`. It read
 * `z1 - z0` — the part's THICKNESS — where the rule says "high", and every extracted upper
 * level is a zero-thickness plane, so every floor in the game was ignored. And it was applied
 * on every killzone, not the one that prints it, so an operative on a stronghold roof was in
 * control range of the enemy standing underneath it.
 */
function controlRangeIgnores(p: IndexedPart): boolean {
  const kind = p.feature.kind;
  const isStronghold = kind === 'volkus.strongholdA' || kind === 'volkus.strongholdB';
  if (p.role === 'door' && (isStronghold || kind === 'volkus.largeRuin')) return true;
  return isStronghold && p.z1 < 2;
}

export function withinControlRange(index: TerrainIndex, a: Body, b: Body): boolean {
  if (a.id === b.id) return true;
  if (baseGap(a.pos, a.base, a.rot, b.pos, b.base, b.rot) > 1 + 1e-6) return false;
  return (
    isVisible(index, a, b, { forControlRange: true }).visible ||
    isVisible(index, b, a, { forControlRange: true }).visible
  );
}

// ---------------------------------------------------------------------------
// Targeting lines
// ---------------------------------------------------------------------------

export interface TargetingLine {
  from: Vec3;
  to: Vec3;
}

/**
 * Lines from any point of the shooter's base to every FACING part of the target's base.
 * 2D when both are at the same height, 3D otherwise ("if there's a difference in height
 * between the operatives... targeting lines should be drawn in a three-dimensional manner").
 */
export function targetingLines(a: Body, b: Body, samples = 12): TargetingLine[] {
  const aPts = basePerimeter(a.pos, a.base, a.rot, samples);
  const bPts = basePerimeter(b.pos, b.base, b.rot, samples);
  const dir = sub(b.pos, a.pos);
  // "every facing part" — the half of the target's base that faces the shooter.
  const facing = bPts.filter((p) => dot(sub(p, b.pos), dir) <= 1e-9);
  const bTargets = facing.length >= 3 ? facing : bPts;
  const lines: TargetingLine[] = [];
  for (const p of aPts) {
    for (const q of bTargets) {
      lines.push({ from: { x: p.x, y: p.y, z: a.z }, to: { x: q.x, y: q.y, z: b.z } });
    }
  }
  return lines;
}

export interface InterveningResult {
  /** Parts at least one line crosses. */
  any: IndexedPart[];
  /** Parts every line crosses. */
  wholly: IndexedPart[];
}

interface InterveningOpts {
  ignore?: (part: IndexedPart) => boolean;
  samples?: number;
}

/**
 * Which terrain parts are intervening between two bodies?
 * Exposed terrain "for the purposes of cover and obscured, it's never intervening".
 * Wall terrain: "only the corners and ends of Wall terrain can intervene, unless the
 * active operative has passed it".
 */
export function interveningParts(
  index: TerrainIndex,
  a: Body,
  b: Body,
  opts: InterveningOpts = {},
): InterveningResult {
  const lines = targetingLines(a, b, opts.samples ?? 10);
  const any: IndexedPart[] = [];
  const wholly: IndexedPart[] = [];
  // "Anything at least one of these lines cross is intervening." A line drawn between two
  // operatives standing on the same surface runs ALONG that surface; it does not cross it.
  // `segmentCrossesPoly` answers true whenever an endpoint is inside the polygon, so without
  // this the floor under both of them counted as intervening — and, being within 1" of the
  // target, as cover. Everyone on an upper level was permanently in cover from everyone else
  // on it.
  const underfoot = new Set<string>([
    ...partsSupporting(index, a.pos, a.z).map((p) => p.id),
    ...partsSupporting(index, b.pos, b.z).map((p) => p.id),
  ]);
  for (const part of index.parts) {
    if (hasType(part, 'Exposed')) continue;
    if (underfoot.has(part.id)) continue;
    if (opts.ignore?.(part)) continue;
    if (!segmentMayHitPart(part, a.pos, b.pos)) continue;

    const polys: Poly[] = hasType(part, 'Wall')
      ? wallCornerZones(part).filter((zone) => {
          const c = polyCentroid2(zone);
          return !shooterHasPassed(c, a.pos, b.pos);
        })
      : [part.poly];
    if (polys.length === 0) continue;

    let crossed = 0;
    for (const line of lines) {
      const p0 = v2(line.from.x, line.from.y);
      const p1 = v2(line.to.x, line.to.y);
      const sameHeight = Math.abs(a.z - b.z) < 0.05;
      const hit = polys.some((poly) =>
        sameHeight
          ? segmentCrossesPoly(p0, p1, poly)
          : segmentIntersectsPrism(line.from, line.to, poly, part.z0, hasType(part, 'Wall') ? WALL_VIRTUAL_TOP : part.z1),
      );
      if (hit) crossed++;
    }
    if (crossed > 0) any.push(part);
    if (crossed === lines.length) wholly.push(part);
  }
  return { any, wholly };
}

function polyCentroid2(poly: Poly): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return v2(x / poly.length, y / poly.length);
}

// ---------------------------------------------------------------------------
// Cover / obscured
// ---------------------------------------------------------------------------

export interface CoverResult {
  /**
   * The TRUE cover state, which decides the cover save.
   *
   * Seek / Seek Light and the Vantage Light denial both stop a Conceal operative hiding
   * behind terrain when you pick a target, and both say the same thing about the save:
   * "Whilst this can allow such operatives to be targeted (assuming they're visible), it
   * doesn't remove their cover save (if any)." So they narrow `inCoverForTargeting` and
   * leave this alone.
   */
  inCover: boolean;
  /** Cover as the VALID TARGET test sees it, with Seek / Vantage denials applied. */
  inCoverForTargeting: boolean;
  obscured: boolean;
  coverParts: IndexedPart[];
  /** The parts left after the targeting denials — what made `inCoverForTargeting`. */
  targetingCoverParts: IndexedPart[];
  obscuringParts: IndexedPart[];
  /** Set when a single feature would give both, forcing the defender to choose. */
  mustChoose: boolean;
  /** Rule name explaining a negative result, for the UI. */
  reason?: string;
}

export interface CoverOpts {
  /** Seek / Seek Light: which terrain cannot be USED for cover when picking a target. */
  ignoreCoverTerrain?: 'none' | 'light' | 'all';
  /** A rule that says the operative "cannot be in cover" — the save goes with it. */
  denyCover?: boolean;
  /** Vantage: the shooter is >=2" above a Conceal target, so Light cover is denied. */
  vantageDeniesLightCover?: boolean;
  /** Extra parts that are not intervening at all (smoke is handled separately). */
  ignore?: (part: IndexedPart) => boolean;
  /**
   * Vantage: "for the purposes of OBSCURED, ignore Heavy terrain connected to Vantage
   * terrain the active operative or the intended target is on." Obscured only — passing this
   * as `ignore` also deleted the cover the same Heavy part was giving.
   */
  ignoreForObscured?: (part: IndexedPart) => boolean;
}

/**
 * Determine cover and obscured for `target` from `shooter`.
 *
 * Cover: intervening terrain within the TARGET's control range (visible to and within 1"),
 * denied while the two are within 2" of each other.
 * Obscured: intervening Heavy terrain, ignoring Heavy parts within 1" of EITHER operative.
 */
export function coverAndObscured(
  index: TerrainIndex,
  shooter: Body,
  target: Body,
  opts: CoverOpts = {},
): CoverResult {
  const gap = baseGap(shooter.pos, shooter.base, shooter.rot, target.pos, target.base, target.rot);
  const inter = interveningParts(index, shooter, target, { ...(opts.ignore ? { ignore: opts.ignore } : {}) });

  // --- cover -------------------------------------------------------------
  const coverParts: IndexedPart[] = [];
  const targetingCoverParts: IndexedPart[] = [];
  if (gap > 2 + 1e-6 && !opts.denyCover) {
    for (const part of inter.any) {
      // "within its control range": visible to and within 1" of the TARGET.
      if (baseDistanceToPart(target.pos, target.base, target.rot, part) > 1 + 1e-6) continue;
      coverParts.push(part);
      const lightOnly = hasType(part, 'Light') && !hasType(part, 'Heavy');
      if (opts.ignoreCoverTerrain === 'all') continue;
      if (opts.ignoreCoverTerrain === 'light' && lightOnly) continue;
      if (opts.vantageDeniesLightCover && lightOnly) continue;
      targetingCoverParts.push(part);
    }
  }

  // --- obscured ----------------------------------------------------------
  const obscuringParts: IndexedPart[] = [];
  for (const part of inter.any) {
    if (!hasType(part, 'Heavy')) continue;
    if (opts.ignoreForObscured?.(part)) continue;
    const dS = baseDistanceToPart(shooter.pos, shooter.base, shooter.rot, part);
    const dT = baseDistanceToPart(target.pos, target.base, target.rot, part);
    if (dS <= 1 + 1e-6 || dT <= 1 + 1e-6) continue; // ignored, per the 1" rule
    obscuringParts.push(part);
  }

  // "An operative cannot be in cover from and obscured by the same terrain feature. If it
  // would be, the defender must select one of them for that sequence."
  const coverFeatures = new Set(coverParts.map((p) => p.featureId));
  const obscureFeatures = new Set(obscuringParts.map((p) => p.featureId));
  let shared = false;
  for (const f of coverFeatures) if (obscureFeatures.has(f)) shared = true;

  const result: CoverResult = {
    inCover: coverParts.length > 0,
    inCoverForTargeting: targetingCoverParts.length > 0,
    obscured: obscuringParts.length > 0,
    coverParts,
    targetingCoverParts,
    obscuringParts,
    mustChoose: shared && coverParts.length > 0 && obscuringParts.length > 0,
  };
  if (!result.inCover && gap <= 2 + 1e-6) result.reason = 'within 2" of the active operative';
  return result;
}

/**
 * Vantage: "for the purposes of obscured, ignore Heavy terrain connected to Vantage terrain
 * the active operative or the intended target is on."
 */
export function vantageIgnoreFilter(index: TerrainIndex, shooter: Body, target: Body): (p: IndexedPart) => boolean {
  const featureIds = new Set<string>();
  for (const body of [shooter, target]) {
    for (const part of index.standable) {
      if (Math.abs(part.z1 - body.z) < 0.05 && pointInPoly(body.pos, part.poly) && hasType(part, 'Vantage')) {
        featureIds.add(part.featureId);
      }
    }
  }
  if (featureIds.size === 0) return () => false;
  return (p: IndexedPart) => hasType(p, 'Heavy') && featureIds.has(p.featureId);
}

/**
 * Vantage Accurate: "whenever an operative on Vantage terrain is shooting an operative that
 * has an Engage order, its ranged weapon has Accurate 1 if the target is at least 2" lower,
 * or Accurate 2 if at least 4" lower."
 */
export function vantageAccurate(index: TerrainIndex, shooter: Body, target: Body): number {
  if (!isOnVantage(index, shooter)) return 0;
  const drop = shooter.z - target.z;
  if (drop >= 4 - 1e-6) return 2;
  if (drop >= 2 - 1e-6) return 1;
  return 0;
}

export function isOnVantage(index: TerrainIndex, b: Body): boolean {
  if (b.z <= 1e-6) return false;
  return index.standable.some(
    (p) => hasType(p, 'Vantage') && Math.abs(p.z1 - b.z) < 0.05 && pointInPoly(b.pos, p.poly),
  );
}

// ---------------------------------------------------------------------------
// Smoke (universal equipment) — a dynamic obscuring volume
// ---------------------------------------------------------------------------

export interface SmokeArea {
  markerId: string;
  centre: Vec2;
  /** "an area of smoke 1" horizontally and unlimited height vertically from (but not below) it." */
  z0: number;
  radius: number;
}

export function whollyWithinSmoke(b: Body, smoke: SmokeArea[]): boolean {
  const pts = [b.pos, ...basePerimeter(b.pos, b.base, b.rot, 16)];
  return smoke.some((s) => b.z + 1e-6 >= s.z0 && pts.every((p) => dist(p, s.centre) <= s.radius + 1e-6));
}

/**
 * "While an operative is wholly within an area of smoke, it's obscured to operatives more
 * than 2" from it, and vice versa."
 */
export function smokeObscures(shooter: Body, target: Body, smoke: SmokeArea[]): boolean {
  if (smoke.length === 0) return false;
  const gap = baseGap(shooter.pos, shooter.base, shooter.rot, target.pos, target.base, target.rot);
  if (gap <= 2 + 1e-6) return false;
  return whollyWithinSmoke(target, smoke) || whollyWithinSmoke(shooter, smoke);
}
