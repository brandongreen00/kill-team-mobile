/**
 * Pure 2D/3D geometry. Inches everywhere; board origin bottom-left, +y up.
 *
 * Core rules › Distances: "measure from the closest part... for operatives, measure to
 * and from their bases only". Hence base-to-base gap, not centre-to-centre.
 */
import type { BaseShape, Poly, Segment, Vec2, Vec3 } from './types.ts';
import { MM_PER_INCH } from './types.ts';

export const EPS = 1e-9;

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
export const rotate = (a: Vec2, deg: number): Vec2 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

export const mmToInches = (mm: number): number => mm / MM_PER_INCH;

/** Circumscribed radius of a base in inches (long semi-axis for ovals). */
export function baseRadius(base: BaseShape): number {
  if (base.shape === 'round') return mmToInches(base.mm) / 2;
  return mmToInches(Math.max(base.mm[0], base.mm[1])) / 2;
}

/** Inscribed radius of a base in inches (short semi-axis for ovals). */
export function baseInnerRadius(base: BaseShape): number {
  if (base.shape === 'round') return mmToInches(base.mm) / 2;
  return mmToInches(Math.min(base.mm[0], base.mm[1])) / 2;
}

/** Semi-axes (a along facing, b across) in inches. */
export function baseSemiAxes(base: BaseShape): { a: number; b: number } {
  if (base.shape === 'round') {
    const r = mmToInches(base.mm) / 2;
    return { a: r, b: r };
  }
  return { a: mmToInches(base.mm[0]) / 2, b: mmToInches(base.mm[1]) / 2 };
}

/** Sample the perimeter of a base as world-space points. `n` >= 8 recommended. */
export function basePerimeter(centre: Vec2, base: BaseShape, rotDeg: number, n = 24): Vec2[] {
  const { a, b } = baseSemiAxes(base);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const local = { x: a * Math.cos(t), y: b * Math.sin(t) };
    const r = base.shape === 'round' ? local : rotate(local, rotDeg);
    out.push(add(centre, r));
  }
  return out;
}

/**
 * Base-to-base gap in inches: `max(0, dist(centres) - r_a - r_b)` for round bases,
 * perimeter sampling for ovals (tolerance <= 0.02" at n=32, pinned by a test).
 */
export function baseGap(
  aPos: Vec2,
  aBase: BaseShape,
  aRot: number,
  bPos: Vec2,
  bBase: BaseShape,
  bRot: number,
  samples = 32,
): number {
  if (aBase.shape === 'round' && bBase.shape === 'round') {
    return Math.max(0, dist(aPos, bPos) - baseRadius(aBase) - baseRadius(bBase));
  }
  // Mixed / oval: sample both perimeters and take the minimum pairwise distance,
  // then clamp to 0 when the shapes overlap.
  const pa = basePerimeter(aPos, aBase, aRot, samples);
  const pb = basePerimeter(bPos, bBase, bRot, samples);
  let best = Infinity;
  for (const p of pa) for (const q of pb) best = Math.min(best, dist(p, q));
  // Overlap check: is either centre inside the other ellipse, or do perimeters cross?
  if (pointInEllipse(aPos, bPos, bBase, bRot) || pointInEllipse(bPos, aPos, aBase, aRot)) return 0;
  for (let i = 0; i < pa.length; i++) {
    const s1: Segment = { a: pa[i]!, b: pa[(i + 1) % pa.length]! };
    for (let j = 0; j < pb.length; j++) {
      const s2: Segment = { a: pb[j]!, b: pb[(j + 1) % pb.length]! };
      if (segmentsIntersect(s1.a, s1.b, s2.a, s2.b)) return 0;
    }
  }
  return Math.max(0, best);
}

/**
 * The gap between two OPERATIVES, which is a three-dimensional measurement.
 *
 * Core rules › Distances: "When measuring to and from something, do so from the closest part
 * of it. For an operative, do so from its base… **When measuring to and from an AREA OF THE
 * KILLZONE, measure the horizontal distance only** (in other words, look from above to ignore
 * the vertical distance)." The horizontal-only clause is for areas — drop zones, territories,
 * the centre of the killzone — not for operatives.
 *
 * `baseGap` takes no elevation, and every operative-to-operative measurement in the kernel
 * went through it, so two operatives 3" apart vertically and 0.14" apart horizontally measured
 * as 0.14" apart: an operative on a Vantage platform was in control range of one on the floor
 * below it, could not Shoot because it was "within control range of an enemy", and could Fight
 * a model standing three inches beneath it.
 */
export function bodyGap(
  aPos: Vec2,
  aBase: BaseShape,
  aRot: number,
  aZ: number,
  bPos: Vec2,
  bBase: BaseShape,
  bRot: number,
  bZ: number,
): number {
  const dz = aZ > bZ ? aZ - bZ : bZ - aZ;
  const flat = baseGap(aPos, aBase, aRot, bPos, bBase, bRot);
  // `Math.hypot` is variadic and markedly slower than the two-argument form in V8; this sits
  // under every control-range and Range x test the engine makes.
  return dz <= 1e-9 ? flat : Math.sqrt(flat * flat + dz * dz);
}

export function pointInEllipse(p: Vec2, centre: Vec2, base: BaseShape, rotDeg: number): boolean {
  const { a, b } = baseSemiAxes(base);
  const d = sub(p, centre);
  const l = base.shape === 'round' ? d : rotate(d, -rotDeg);
  return (l.x * l.x) / (a * a) + (l.y * l.y) / (b * b) <= 1 + EPS;
}

/**
 * Do two bases interpenetrate? Core rules › Bases: "The sides of different bases can
 * touch, but a base cannot be placed on another" — so touching is legal and only real
 * overlap is not. `tol` is the permitted touching slack in inches.
 */
export function basesOverlap(
  aPos: Vec2,
  aBase: BaseShape,
  aRot: number,
  bPos: Vec2,
  bBase: BaseShape,
  bRot: number,
  tol = 1e-4,
): boolean {
  if (aBase.shape === 'round' && bBase.shape === 'round') {
    return dist(aPos, bPos) < baseRadius(aBase) + baseRadius(bBase) - tol;
  }
  // Ellipses: conservative inscribed-circle quick accept, then perimeter/containment test.
  if (dist(aPos, bPos) < baseInnerRadius(aBase) + baseInnerRadius(bBase) - tol) return true;
  if (dist(aPos, bPos) > baseRadius(aBase) + baseRadius(bBase) + tol) return false;
  if (pointInEllipse(aPos, bPos, bBase, bRot) || pointInEllipse(bPos, aPos, aBase, aRot)) return true;
  const pa = basePerimeter(aPos, aBase, aRot, 32);
  const pb = basePerimeter(bPos, bBase, bRot, 32);
  for (let i = 0; i < pa.length; i++) {
    for (let j = 0; j < pb.length; j++) {
      if (segmentsIntersect(pa[i]!, pa[(i + 1) % pa.length]!, pb[j]!, pb[(j + 1) % pb.length]!)) return true;
    }
  }
  return false;
}

// --- polygons --------------------------------------------------------------

export function pointInPoly(p: Vec2, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const intersect =
      pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y + EPS) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polyArea(poly: Poly): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j]!.x * poly[i]!.y - poly[i]!.x * poly[j]!.y;
  }
  return a / 2;
}

export function polyCentroid(poly: Poly): Vec2 {
  const a = polyArea(poly);
  if (Math.abs(a) < EPS) {
    // Degenerate: average the vertices.
    const s = poly.reduce((acc, p) => add(acc, p), v2(0, 0));
    return mul(s, 1 / Math.max(1, poly.length));
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i]!;
    const q = poly[j]!;
    const f = q.x * p.y - p.x * q.y;
    cx += (q.x + p.x) * f;
    cy += (q.y + p.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function polyBounds(poly: Poly): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: v2(minX, minY), max: v2(maxX, maxY) };
}

export function distancePointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return dist(p, a);
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, add(a, mul(ab, t)));
}

/** Horizontal distance from a point to a polygon (0 if inside). */
export function distancePointToPoly(p: Vec2, poly: Poly): number {
  if (pointInPoly(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    best = Math.min(best, distancePointToSegment(p, poly[j]!, poly[i]!));
  }
  return best;
}

export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = cross(sub(p4, p3), sub(p1, p3));
  const d2 = cross(sub(p4, p3), sub(p2, p3));
  const d3 = cross(sub(p2, p1), sub(p3, p1));
  const d4 = cross(sub(p2, p1), sub(p4, p1));
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (a: Vec2, b: Vec2, c: Vec2) =>
    Math.abs(cross(sub(b, a), sub(c, a))) < 1e-9 &&
    Math.min(a.x, b.x) - EPS <= c.x &&
    c.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= c.y &&
    c.y <= Math.max(a.y, b.y) + EPS;
  return onSeg(p3, p4, p1) || onSeg(p3, p4, p2) || onSeg(p1, p2, p3) || onSeg(p1, p2, p4);
}

/** Does a segment cross (or touch) a polygon? */
export function segmentCrossesPoly(a: Vec2, b: Vec2, poly: Poly): boolean {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect(a, b, poly[j]!, poly[i]!)) return true;
  }
  return false;
}

/** Is `poly` wholly inside `container`? Used for "wholly within" checks. */
export function polyWhollyWithin(poly: Poly, container: Poly): boolean {
  for (const p of poly) if (!pointInPoly(p, container)) return false;
  // No edge of poly may exit the container.
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    for (let k = 0, l = container.length - 1; k < container.length; l = k++) {
      if (segmentsIntersect(poly[j]!, poly[i]!, container[l]!, container[k]!)) return false;
    }
  }
  return true;
}

/**
 * "Wholly within" for a base against a set of polygons (a drop zone can be several polys).
 * Approximated by perimeter sampling; sample count pinned by a test to <= 0.02" error.
 */
export function baseWhollyWithin(
  centre: Vec2,
  base: BaseShape,
  rotDeg: number,
  polys: Poly[],
  samples = 32,
): boolean {
  const pts = [centre, ...basePerimeter(centre, base, rotDeg, samples)];
  return pts.every((p) => polys.some((poly) => pointInPoly(p, poly)));
}

/** "Within" for a base against polygons: any part of the base inside any polygon. */
export function baseWithin(centre: Vec2, base: BaseShape, rotDeg: number, polys: Poly[], samples = 32): boolean {
  const pts = [centre, ...basePerimeter(centre, base, rotDeg, samples)];
  return pts.some((p) => polys.some((poly) => pointInPoly(p, poly)));
}

/** Horizontal gap from a base to a polygon (0 if touching/overlapping). */
export function baseGapToPoly(centre: Vec2, base: BaseShape, rotDeg: number, poly: Poly, samples = 32): number {
  if (pointInPoly(centre, poly)) return 0;
  let best = Infinity;
  for (const p of basePerimeter(centre, base, rotDeg, samples)) {
    best = Math.min(best, distancePointToPoly(p, poly));
    if (best === 0) return 0;
  }
  return best;
}

// --- 3D --------------------------------------------------------------------

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/**
 * Segment (3D) vs extruded prism (polygon between z0 and z1).
 * Returns true if the segment passes through the prism's interior.
 *
 * Implementation: clip the segment against the z slab, then test the 2D projection
 * of the clipped span against the polygon (crossing or containment).
 */
export function segmentIntersectsPrism(
  a: Vec3,
  b: Vec3,
  poly: Poly,
  z0: number,
  z1: number,
  tol = 1e-6,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dz = b.z - a.z;
  if (Math.abs(dz) < tol) {
    if (a.z < z0 - tol || a.z > z1 + tol) return false;
  } else {
    const ta = (z0 - a.z) / dz;
    const tb = (z1 - a.z) / dz;
    const lo = Math.min(ta, tb);
    const hi = Math.max(ta, tb);
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return false;
  }
  const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
  const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
  if (dist(p0, p1) < tol) return pointInPoly(p0, poly);
  return segmentCrossesPoly(p0, p1, poly);
}

/** Shortest distance from a 3D point to a segment — used by the elevation inspector. */
export function distancePointToSegment3(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  if (l2 < EPS) return Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
}

/** Round to a tolerance, used to keep extracted geometry stable in JSON. */
export const round = (v: number, step = 0.01): number => Math.round(v / step) * step;
