/**
 * Terrain queries over the 2.5D model. Every rule that touches terrain reads this file.
 *
 * Killzones › Terrain and Movement: "Operatives cannot move through terrain — they must
 * move around, climb over or drop/jump off it."
 * Killzones › Terrain Types: "Always view terrain features in parts, rather than as one
 * large terrain feature where everything is the same."
 */
import {
  baseGapToPoly,
  basePerimeter,
  dist,
  distancePointToPoly,
  pointInPoly,
  polyBounds,
  polyCentroid,
  segmentCrossesPoly,
  v2,
} from './geometry.ts';
import type {
  BaseShape,
  GameState,
  KillzoneMap,
  Poly,
  TerrainFeature,
  TerrainPart,
  TerrainType,
  Vec2,
} from './types.ts';

export interface IndexedPart extends TerrainPart {
  feature: TerrainFeature;
  bounds: { min: Vec2; max: Vec2 };
  typeSet: Set<TerrainType>;
}

export interface TerrainIndex {
  map: KillzoneMap;
  parts: IndexedPart[];
  byId: Map<string, IndexedPart>;
  featureById: Map<string, TerrainFeature>;
  /** Wall parts, for the CQ "measure around" rule and the visibility block. */
  walls: IndexedPart[];
  /** Parts an operative can stand on (Vantage floors, gantries, teleport pads, rubble). */
  standable: IndexedPart[];
  /** Parts that physically stop a base at ground level. */
  solid: IndexedPart[];
  hazardous: Poly[];
}

const OPEN_ACCESS_TYPES: TerrainType[] = ['Accessible', 'Insignificant', 'Exposed'];

/**
 * A part is solid (blocks a base and a visibility line) unless it is explicitly flagged,
 * or it is one of the pure-annotation types. Blocking parts are not physical but DO stop
 * visibility ("Visibility cannot be drawn through such gaps").
 */
function defaultSolid(part: TerrainPart): boolean {
  if (part.solid !== undefined) return part.solid;
  const t = new Set(part.types);
  if (t.has('Wall')) return true;
  if (t.has('Accessible')) return false; // operatives move through it
  if (t.has('Exposed') && t.has('Insignificant')) return false;
  if (t.has('Blocking')) return false; // a gap, not physical — but blocks visibility
  return t.has('Heavy') || t.has('Light') || t.has('Vantage') || t.has('Obstructing') || t.has('Protective');
}

function defaultBlocksVisibility(part: TerrainPart): boolean {
  if (part.blocksVisibility !== undefined) return part.blocksVisibility;
  const t = new Set(part.types);
  if (t.has('Blocking')) return true;
  if (t.has('Wall')) return true;
  // Insignificant + Exposed decoration (fire steps, ramparts' feet, ladders, teleport pads)
  // is too small/open to obstruct a visibility line.
  if (t.has('Exposed') && t.has('Insignificant')) return false;
  if (t.has('Accessible') && t.has('Insignificant')) return false;
  return t.has('Heavy') || t.has('Light') || t.has('Vantage');
}

function defaultStandable(part: TerrainPart): boolean {
  if (part.standable !== undefined) return part.standable;
  const t = new Set(part.types);
  // "Vantage terrain is the upper levels of the killzone — areas operatives can be placed
  // upon above the game board. If terrain is not Vantage terrain, then operatives can move
  // over it, but they cannot finish a move or be set up on it."
  return t.has('Vantage');
}

/** Apply runtime state (open/closed hatchways, opened breach points, removed mines). */
export function effectivePart(part: TerrainPart, state?: GameState): TerrainPart | null {
  const override = state?.terrainState[part.id];
  if (override?.removed) return null;
  const st = override?.state ?? part.state;
  if (st === undefined || part.role === undefined) return part;
  if (part.role === 'accessPoint') {
    return st === 'open'
      ? { ...part, state: st, types: [...OPEN_ACCESS_TYPES], solid: false, blocksVisibility: false }
      : { ...part, state: st, types: ['Heavy', 'Wall'], solid: true, blocksVisibility: true };
  }
  if (part.role === 'hatch') {
    // Tomb World: "While a hatchway is open... its hatch must be removed from the killzone."
    if (st === 'open' && part.featureId.startsWith('tomb-world')) return null;
    // Gallowdark: "Its hatch must be fully open (it cannot be ajar). Its hatch is Heavy and
    // Wall terrain, and the gap directly underneath it is Blocking terrain."
    // The panel keeps those types for cover and obscuring, but it has physically swung clear
    // of the doorway, so it must not block movement, routing or visibility THROUGH the
    // access point it shares a footprint with. Modelling it as still solid sealed every
    // Gallowdark hatchway: opening one changed nothing.
    if (st === 'open') return { ...part, state: st, solid: false, blocksVisibility: false };
    return { ...part, state: st, solid: true, blocksVisibility: true };
  }
  if (part.role === 'breachWall') {
    return st === 'open' ? null : { ...part, state: st };
  }
  if (part.role === 'door') {
    return { ...part, state: st };
  }
  return { ...part, state: st };
}

export function buildTerrainIndex(map: KillzoneMap, state?: GameState): TerrainIndex {
  const parts: IndexedPart[] = [];
  const byId = new Map<string, IndexedPart>();
  const featureById = new Map<string, TerrainFeature>();
  const features = [...map.features, ...(state?.placedFeatures ?? [])];
  for (const feature of features) {
    featureById.set(feature.id, feature);
    for (const raw of feature.parts) {
      const part = effectivePart(raw, state);
      if (!part) continue;
      const idx: IndexedPart = {
        ...part,
        feature,
        bounds: polyBounds(part.poly),
        typeSet: new Set(part.types),
        solid: defaultSolid(part),
        blocksVisibility: defaultBlocksVisibility(part),
        standable: defaultStandable(part),
      };
      parts.push(idx);
      byId.set(idx.id, idx);
    }
  }
  return {
    map,
    parts,
    byId,
    featureById,
    walls: parts.filter((p) => p.typeSet.has('Wall')),
    standable: parts.filter((p) => p.standable),
    solid: parts.filter((p) => p.solid),
    hazardous: map.hazardous ?? [],
  };
}

export const hasType = (p: IndexedPart, t: TerrainType): boolean => p.typeSet.has(t);

/** Highest standable surface at a point, at or below `maxZ`. 0 = killzone floor. */
export function surfaceAt(index: TerrainIndex, p: Vec2, maxZ = Infinity): number {
  let best = 0;
  for (const part of index.standable) {
    if (part.z1 > maxZ + 1e-6) continue;
    if (!withinBounds(part, p)) continue;
    if (pointInPoly(p, part.poly) && part.z1 > best) best = part.z1;
  }
  return best;
}

/** Every standable level under/at a point, ascending — used by the movement planner. */
export function surfacesAt(index: TerrainIndex, p: Vec2): number[] {
  const zs = new Set<number>([0]);
  for (const part of index.standable) {
    if (!withinBounds(part, p)) continue;
    if (pointInPoly(p, part.poly)) zs.add(part.z1);
  }
  return [...zs].sort((a, b) => a - b);
}

function withinBounds(part: IndexedPart, p: Vec2, pad = 0): boolean {
  return (
    p.x >= part.bounds.min.x - pad &&
    p.x <= part.bounds.max.x + pad &&
    p.y >= part.bounds.min.y - pad &&
    p.y <= part.bounds.max.y + pad
  );
}

/** Is the part on the teleport pad / a Vantage floor the operative stands on? */
export function partsSupporting(index: TerrainIndex, p: Vec2, z: number): IndexedPart[] {
  return index.standable.filter((part) => Math.abs(part.z1 - z) < 0.05 && pointInPoly(p, part.poly));
}

/**
 * Would a base placed here collide with solid terrain at this elevation?
 * Accessible parts are traversable (centre-of-base only), so they never collide.
 * Ceiling terrain lets small bases pass underneath.
 */
export function baseBlockedByTerrain(
  index: TerrainIndex,
  centre: Vec2,
  base: BaseShape,
  rotDeg: number,
  z: number,
  height: number,
): IndexedPart | null {
  const pts = [centre, ...basePerimeter(centre, base, rotDeg, 16)];
  for (const part of index.solid) {
    if (part.z1 <= z + 1e-6) continue; // we're standing on or above it
    if (part.z0 >= z + height - 1e-6) continue; // entirely above the model: we pass underneath
    // "Operatives with a round base of 50mm or less, or an oval base of 60x35mm, can move
    // underneath Ceiling terrain REGARDLESS OF THE OPERATIVE'S HEIGHT (this takes precedence
    // over Terrain and Movement)." This test used to sit inside the branch above, where both
    // arms continued — so it never changed an answer, and an operative taller than the
    // clearance was refused a position the rule explicitly allows.
    if (part.z0 >= z + 1e-6 && hasType(part, 'Ceiling') && baseFitsUnderCeiling(base)) continue;
    for (const p of pts) {
      if (withinBounds(part, p) && pointInPoly(p, part.poly)) return part;
    }
  }
  return null;
}

/** Ceiling: "round base of 50mm or less, or an oval base of 60x35mm". */
export function baseFitsUnderCeiling(base: BaseShape): boolean {
  if (base.shape === 'round') return base.mm <= 50;
  const [w, h] = base.mm;
  return (w === 60 && h === 35) || (w === 35 && h === 60);
}

/** Hazardous area (Bheta-Decima): "no operative's base can be touching it". */
export function baseTouchesHazardous(
  index: TerrainIndex,
  centre: Vec2,
  base: BaseShape,
  rotDeg: number,
): boolean {
  if (index.hazardous.length === 0) return false;
  for (const poly of index.hazardous) {
    if (baseGapToPoly(centre, base, rotDeg, poly) <= 1e-6) return true;
  }
  return false;
}

/** Accessible parts whose interior the straight segment passes through (centre of base). */
export function accessibleCrossings(index: TerrainIndex, a: Vec2, b: Vec2, z: number): IndexedPart[] {
  return index.parts.filter(
    (p) => hasType(p, 'Accessible') && p.z0 <= z + 1e-6 && p.z1 >= z - 1e-6 && segmentCrossesPoly(a, b, p.poly),
  );
}

/**
 * The terrain feature ids whose standable surface holds an operative at (p, z). Ground level
 * belongs to no feature, so it returns an empty set.
 */
export function featureIdsSupporting(index: TerrainIndex, p: Vec2, z: number): Set<string> {
  const out = new Set<string>();
  for (const part of partsSupporting(index, p, z)) out.add(part.feature.id);
  return out;
}

/**
 * Killzones › Terrain and Movement: "Operatives cannot move through terrain — they must move
 * around, climb over or drop/jump off it."
 *
 * The part of a straight-line increment that travels HORIZONTALLY at level `z` may not pass
 * through solid terrain standing at that level. Three types are exempt, each by its own rule:
 *
 *  - Accessible — "Operatives can move through Accessible terrain (this takes precedence over
 *    Bases, and Terrain and Movement)". `accessibleCrossings` charges the extra 1".
 *  - Insignificant — "An operative can move over and across Insignificant terrain without
 *    going up and down."
 *  - Ceiling — "Operatives with a round base of 50mm or less, or an oval base of 60x35mm, can
 *    move underneath Ceiling terrain regardless of the operative's height (this takes
 *    precedence over Terrain and Movement)."
 *
 * `exemptFeatureIds` carries the "climb over / drop off IT" half of the rule: the feature an
 * operative is climbing onto or dropping from does not block the increment that does so.
 *
 * The test is against the centre line, matching `accessibleCrossings` and `obstructingCrossings`;
 * the full base is still checked where the operative finishes (`baseBlockedByTerrain`).
 * See docs/DECISIONS.md D-064.
 */
export function pathBlockedByTerrain(
  index: TerrainIndex,
  a: Vec2,
  b: Vec2,
  z: number,
  base: BaseShape,
  height: number,
  exemptFeatureIds?: ReadonlySet<string>,
): IndexedPart | null {
  for (const part of index.solid) {
    if (part.z1 <= z + 1e-6) continue; // level with or below our feet — we walk on or over it
    if (part.z0 >= z + height - 1e-6) continue; // entirely above our head — we walk under it
    // Bounding-box reject first: this runs per increment, and `validateMove` runs thousands of
    // times per AI decision.
    if (!segmentMayHitPart(part, a, b)) continue;
    if (hasType(part, 'Accessible')) continue;
    if (hasType(part, 'Insignificant')) continue;
    if (hasType(part, 'Ceiling') && part.z0 >= z + 1e-6 && baseFitsUnderCeiling(base)) continue;
    if (exemptFeatureIds?.has(part.feature.id)) continue;
    if (segmentCrossesPoly(a, b, part.poly)) return part;
  }
  return null;
}

/** Obstructing equipment (razor wire): +1" when crossing within 1" of it. */
export function obstructingCrossings(index: TerrainIndex, a: Vec2, b: Vec2): IndexedPart[] {
  return index.parts.filter((p) => hasType(p, 'Obstructing') && segmentCrossesPoly(a, b, p.poly));
}

// ---------------------------------------------------------------------------
// Wall routing (Gallowdark / Tomb World)
// ---------------------------------------------------------------------------

/**
 * "Other than to areas of the killzone (centre of the killzone, drop zones, etc.),
 * distances cannot be measured over or through Wall terrain; they must be measured
 * around it using the shortest possible route."
 *
 * Implemented as a visibility graph over wall polygon vertices pushed slightly outward,
 * with Dijkstra. Returns Infinity if no route exists (fully sealed compartments).
 */
export function wallRouteDistance(index: TerrainIndex, a: Vec2, b: Vec2, pad = 0.02): number {
  const solidWalls = index.walls.filter((w) => w.solid !== false);
  if (solidWalls.length === 0) return dist(a, b);
  const blocked = (p: Vec2, q: Vec2): boolean =>
    solidWalls.some((w) => segmentCrossesPoly(p, q, w.poly));
  if (!blocked(a, b)) return dist(a, b);

  const nodes: Vec2[] = [a, b];
  for (const w of solidWalls) {
    const c = polyCentroid(w.poly);
    for (const v of w.poly) {
      const dx = v.x - c.x;
      const dy = v.y - c.y;
      const l = Math.hypot(dx, dy) || 1;
      nodes.push(v2(v.x + (dx / l) * pad, v.y + (dy / l) * pad));
    }
  }
  const n = nodes.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  const w: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => Infinity));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (blocked(nodes[i]!, nodes[j]!)) continue;
      const d = dist(nodes[i]!, nodes[j]!);
      adj[i]!.push(j);
      adj[j]!.push(i);
      w[i]![j] = d;
      w[j]![i] = d;
    }
  }
  const distArr = new Array<number>(n).fill(Infinity);
  const done = new Array<boolean>(n).fill(false);
  distArr[0] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && distArr[i]! < best) ((best = distArr[i]!), (u = i));
    if (u < 0) break;
    done[u] = true;
    if (u === 1) return distArr[1]!;
    for (const v of adj[u]!) {
      const nd = distArr[u]! + w[u]![v]!;
      if (nd < distArr[v]!) distArr[v] = nd;
    }
  }
  return distArr[1]!;
}

/**
 * Wall corner / end points. "For the purposes of cover and obscured, only the corners and
 * ends of Wall terrain can intervene". A vertex counts as a corner when the polygon turns
 * meaningfully there (protruding detail does not count — "it must be the main structure of
 * the wall that turns a corner or ends").
 */
export function wallCornerZones(part: IndexedPart, minEdge = 0.6, radius = 0.35): Poly[] {
  const poly = part.poly;
  const zones: Poly[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n]!;
    const cur = poly[i]!;
    const next = poly[(i + 1) % n]!;
    // "…minor parts of the wall that protrude do not make a corner or end alone; it must be
    // the MAIN STRUCTURE of the wall that turns a corner or ends." A vertex belongs to the
    // main structure when at least one of its edges is a substantial run — not when BOTH are.
    // Requiring both discarded every vertex of every extracted wall, because each is a
    // rectangle 0.365" thick and every vertex has one 0.365" edge: `wallCornerZones` returned
    // [] for all 94 wall parts across the Gallowdark maps, `interveningParts` then skipped the
    // wall entirely, and on the killzones where walls are essentially the only terrain nobody
    // was ever in cover and nobody was ever obscured.
    if (Math.max(dist(prev, cur), dist(cur, next)) < minEdge) continue;
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const cosang =
      (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    if (cosang > 0.85) continue; // nearly straight — not a corner
    zones.push(squareAround(cur, radius));
  }
  return zones;
}

function squareAround(c: Vec2, r: number): Poly {
  return [v2(c.x - r, c.y - r), v2(c.x + r, c.y - r), v2(c.x + r, c.y + r), v2(c.x - r, c.y + r)];
}

/**
 * "unless the active operative has passed it" — the active operative has passed a wall
 * corner when it is on the far side of the line through that corner along the wall's
 * main axis, i.e. when the corner is behind the shooter relative to the target.
 */
export function shooterHasPassed(corner: Vec2, shooter: Vec2, target: Vec2): boolean {
  const dx = target.x - shooter.x;
  const dy = target.y - shooter.y;
  const l = Math.hypot(dx, dy) || 1;
  const t = ((corner.x - shooter.x) * dx + (corner.y - shooter.y) * dy) / (l * l);
  return t < 0;
}

/** Bounding-box quick reject for a segment against a part. */
export function segmentMayHitPart(part: IndexedPart, a: Vec2, b: Vec2): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return !(
    maxX < part.bounds.min.x ||
    minX > part.bounds.max.x ||
    maxY < part.bounds.min.y ||
    minY > part.bounds.max.y
  );
}

/** Horizontal distance from a base to a part's footprint (used by the "within 1"" rules). */
export function baseDistanceToPart(
  centre: Vec2,
  base: BaseShape,
  rotDeg: number,
  part: IndexedPart,
): number {
  return baseGapToPoly(centre, base, rotDeg, part.poly);
}

export function pointDistanceToPart(p: Vec2, part: IndexedPart): number {
  return distancePointToPoly(p, part.poly);
}
