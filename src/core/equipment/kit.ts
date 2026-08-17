/**
 * Universal-equipment kit: the physical items, their footprints, and the per-item set-up
 * constraints.
 *
 * Universal Equipment: "The following equipment options are available to all kill teams,
 * alongside their faction equipment. You cannot select each option more than once per battle."
 *
 * Every terrain item is built as a real `TerrainFeature` with `z0`/`z1`, so the same
 * cylinder-vs-prism visibility, cover and movement code applies to it — there are no special
 * cases for equipment anywhere in the engine.
 *
 * Footprints are the owner's physical measurements (mm), converted once here. Two depths are
 * not printed anywhere and are ASSUMPTIONS, flagged in docs/OPS.md: the heavy barricade (15mm)
 * and the portable barricade (10mm).
 */
import { distancePointToPoly, pointInPoly, rotate, segmentsIntersect } from '../geometry.ts';
import { hasType, type IndexedPart, type TerrainIndex } from '../terrain.ts';
import { MM_PER_INCH } from '../types.ts';
import type {
  MarkerKind,
  Poly,
  TerrainFeature,
  TerrainPart,
  TerrainType,
  Vec2,
} from '../types.ts';
import type { EquipmentDef } from '../context.ts';

export const inches = (millimetres: number): number => millimetres / MM_PER_INCH;

/** All non-objective markers are 20mm (core rules › Markers). */
export const MARKER_MM = 20;

export type PlacementConstraint =
  | 'whollyWithinTerritory'
  | 'whollyWithin4OfDropZone'
  | 'onKillzoneFloor'
  | 'moreThan2FromEquipmentTerrain'
  | 'moreThan2FromAccessPoints'
  | 'moreThan2FromAccessible'
  | 'moreThan2FromMarkers'
  | 'moreThan1FromDoorsAndAccessPoints'
  | 'uprightAgainstTerrain2Tall';

export interface FootprintMm {
  /** Width along the item's facing. */
  w: number;
  /** Depth (thickness). */
  d: number;
  /** Height above the killzone floor. */
  h: number;
}

export interface EquipmentItem {
  kind: 'marker' | 'terrain';
  markerKind?: MarkerKind;
  footprintMm?: FootprintMm;
  types?: TerrainType[];
  /** Barricades: "except the feet, which are Insignificant and Exposed". */
  feet?: boolean;
  /** Feature kind, e.g. 'equipment.ladder' (the movement code keys ladders off this). */
  featureKind?: string;
  constraints: PlacementConstraint[];
}

export interface EquipmentModule extends EquipmentDef {
  /** One entry per physical item ("it's item by item, not option by option"). */
  items?: EquipmentItem[];
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Axis-aligned-then-rotated rectangle, centred on `centre`. */
export function rectPoly(centre: Vec2, wIn: number, dIn: number, rotDeg: number): Poly {
  const hw = wIn / 2;
  const hd = dIn / 2;
  return [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ].map((p) => {
    const r = rotate(p, rotDeg);
    return { x: centre.x + r.x, y: centre.y + r.y };
  });
}

/** Shortest distance between two polygons; 0 when they touch or overlap. */
export function polyGap(a: Poly, b: Poly): number {
  for (const p of a) if (pointInPoly(p, b)) return 0;
  for (const p of b) if (pointInPoly(p, a)) return 0;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    for (let k = 0, l = b.length - 1; k < b.length; l = k++) {
      if (segmentsIntersect(a[j]!, a[i]!, b[l]!, b[k]!)) return 0;
    }
  }
  let best = Infinity;
  for (const p of a) best = Math.min(best, distancePointToPoly(p, b));
  for (const p of b) best = Math.min(best, distancePointToPoly(p, a));
  return best;
}

export const allPointsWithin = (pts: Vec2[], polys: Poly[]): boolean =>
  polys.length > 0 && pts.every((p) => polys.some((poly) => pointInPoly(p, poly)));

export const allPointsWithinDistance = (pts: Vec2[], polys: Poly[], inchesAway: number): boolean =>
  polys.length > 0 && pts.every((p) => polys.some((poly) => distancePointToPoly(p, poly) <= inchesAway + 1e-6));

// ---------------------------------------------------------------------------
// Feature construction
// ---------------------------------------------------------------------------

export interface BuildOpts {
  id: string;
  kind: string;
  owner: 'p1' | 'p2';
  pos: Vec2;
  rotDeg: number;
  item: EquipmentItem;
}

/**
 * Build the terrain feature for one equipment item. The main part carries the item's terrain
 * types; barricade feet are separate Insignificant + Exposed parts so they never intervene.
 */
export function buildEquipmentFeature(opts: BuildOpts): TerrainFeature {
  const { id, kind, owner, pos, rotDeg, item } = opts;
  const fp = item.footprintMm ?? { w: 20, d: 10, h: 1 };
  const w = inches(fp.w);
  const d = inches(fp.d);
  const h = inches(fp.h);
  const types = item.types ?? ['Light'];
  const insignificant = types.includes('Insignificant');
  const parts: TerrainPart[] = [
    {
      id: `${id}.body`,
      featureId: id,
      poly: rectPoly(pos, w, d, rotDeg),
      z0: 0,
      z1: h,
      types: [...types],
      role: 'equipment',
      solid: !insignificant,
      blocksVisibility: !insignificant && !types.includes('Exposed'),
      standable: false,
    },
  ];
  if (item.feet) {
    // "except the feet, which are Insignificant and Exposed"
    const footW = inches(6);
    const footD = inches(fp.d) + inches(8);
    for (const [i, sign] of [-1, 1].entries()) {
      const offset = rotate({ x: (sign * (w - footW)) / 2, y: 0 }, rotDeg);
      parts.push({
        id: `${id}.foot${i}`,
        featureId: id,
        poly: rectPoly({ x: pos.x + offset.x, y: pos.y + offset.y }, footW, footD, rotDeg),
        z0: 0,
        z1: inches(4),
        types: ['Insignificant', 'Exposed'],
        role: 'equipment',
        solid: false,
        blocksVisibility: false,
        standable: false,
      });
    }
  }
  return { id, kind, parts, placement: { x: pos.x, y: pos.y, rotDeg, flip: false }, owner };
}

/** Every polygon of a feature, for distance checks. */
export const featurePolys = (feature: TerrainFeature): Poly[] => feature.parts.map((p) => p.poly);

// ---------------------------------------------------------------------------
// Terrain queries used by the placement rules
// ---------------------------------------------------------------------------

export const accessPointParts = (index: TerrainIndex): IndexedPart[] =>
  index.parts.filter((p) => p.role === 'accessPoint');

export const doorParts = (index: TerrainIndex): IndexedPart[] => index.parts.filter((p) => p.role === 'door');

export const accessibleParts = (index: TerrainIndex): IndexedPart[] =>
  index.parts.filter((p) => hasType(p, 'Accessible'));

/** Terrain at least 2" tall — what a ladder must be set up against. */
export const tallParts = (index: TerrainIndex): IndexedPart[] =>
  index.parts.filter((p) => p.z1 - p.z0 >= 2 - 1e-6 && p.z1 >= 2 - 1e-6);
