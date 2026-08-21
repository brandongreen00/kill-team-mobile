/**
 * Rubble pieces are rectangles. All of them, on every card.
 *
 * Light rubble, heavy rubble, the wreckage, the beam rubble, the cargo crates and the Tomb
 * World debris are all single flat slabs whose printed footprint is an axis-aligned box, so
 * "4 vertices, and the bbox matches the piece's own template" is an invariant the extractor
 * can never legitimately break. It is also the cheapest possible detector for the whole class
 * of bug behind D-014's dashed-rectangle recall: when the extractor fails to recognise a
 * piece's dashed outline, that piece is instead carved out of the neighbouring terrain's
 * blob, and what lands in the map JSON is a 16-26 vertex fragment of somebody else's
 * silhouette. Nothing downstream — board render, visibility, movement — can tell.
 *
 * The tolerance is 0.05", roughly one card pixel at the 24 px/inch scale the cards calibrate
 * to.  Rotation is free: a piece is placed at any 90-degree multiple, so either orientation of
 * the template counts as a match.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KillzoneMap } from '../src/core/types.ts';

const MAPS_DIR = join(process.cwd(), 'data', 'maps');
const TERRAIN_DIR = join(process.cwd(), 'data', 'terrain');

/** Roles whose part is one printed slab: always a rectangle. */
const RUBBLE_ROLES = new Set(['rubble', 'crate']);
const TOL_IN = 0.05;

/**
 * Features that do NOT hold the invariant yet, each with the reason. A `mapId.label` here must
 * still be failing: an entry that starts passing fails the test, so the list cannot outlive the
 * bug. `tools/maps/validate_maps.py` carries the same list as an IoU allow-list — keep them in
 * step, and delete from both after `pnpm maps:extract` regenerates the map from the cards.
 */
const PENDING: Record<string, string> = {
  // D-014 dashed-rectangle recall. The piece's outline was missed, so it was cut out of the
  // raised level it tucks under and is a fragment of that silhouette instead of a rectangle.
  'volkus-3.K': 'D-014 recall: cut out of large ruin D instead of its own dashed rectangle',
  'volkus-5.J': 'D-014 recall: cut out of large ruin C instead of its own dashed rectangle',
  'volkus-6.K': 'D-014 recall: cut out of stronghold A instead of its own dashed rectangle',
  'volkus-4.I': 'traced as an 8-vertex blob; the piece is printed touching its neighbour',
  // Detected dashed rectangles whose box is the OUTER extent of the dash stroke, so the
  // footprint comes out ~0.08" (2px) large on both axes.
  'volkus-1.G': 'D-014 box is the outer extent of the dash stroke, not its centreline',
  'volkus-2.G': 'D-014 box is the outer extent of the dash stroke, not its centreline',
  'volkus-6.I': 'D-014 box is the outer extent of the dash stroke, not its centreline',
  // Tracing slop, unrelated to D-014; tracked with the tracer, not this invariant.
  'volkus-4.H': 'traced 0.10" short on the long axis',
  'volkus-5.H': 'traced 0.10" short on the long axis',
  'volkus-6.H': 'traced 0.10" short on the long axis',
  'tomb-world-5.C5': 'traced 0.16" wide; close-quarters light terrain, tracked with the CQ tiler',
  'tomb-world-6.C2': 'traced 0.08" wide; close-quarters light terrain, tracked with the CQ tiler',
};

interface Pt { x: number; y: number }

function loadMaps(): KillzoneMap[] {
  if (!existsSync(MAPS_DIR)) return [];
  const out: KillzoneMap[] = [];
  for (const kz of readdirSync(MAPS_DIR)) {
    for (const f of readdirSync(join(MAPS_DIR, kz))) {
      if (f.endsWith('.json')) {
        out.push(JSON.parse(readFileSync(join(MAPS_DIR, kz, f), 'utf8')) as KillzoneMap);
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** `killzone|label` -> the template footprint's extent, from data/terrain. */
function loadTemplates(): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (!existsSync(TERRAIN_DIR)) return out;
  for (const f of readdirSync(TERRAIN_DIR)) {
    if (!f.endsWith('.json')) continue;
    const t = JSON.parse(readFileSync(join(TERRAIN_DIR, f), 'utf8')) as {
      killzone: string;
      pieces: { footprints?: Record<string, Pt[]> }[];
    };
    for (const piece of t.pieces) {
      for (const [label, poly] of Object.entries(piece.footprints ?? {})) {
        out.set(`${t.killzone}|${label}`, extent(poly));
      }
    }
  }
  return out;
}

function extent(poly: Pt[]): [number, number] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

function area(poly: Pt[]): number {
  let a = 0;
  poly.forEach((p, i) => {
    const q = poly[(i + 1) % poly.length] as Pt;
    a += p.x * q.y - q.x * p.y;
  });
  return Math.abs(a) / 2;
}

/**
 * A rectangle: four corners that fill their own bounding box. Traced polygons carry up to
 * half a card pixel of slop on a corner, so this is a fill ratio rather than an exact
 * axis-alignment test — a rotated or L-shaped quad fills far less than FILL_MIN of its bbox.
 */
const FILL_MIN = 0.92;

function isRect(poly: Pt[]): boolean {
  if (poly.length !== 4) return false;
  const [w, h] = extent(poly);
  return w > 0 && h > 0 && area(poly) / (w * h) >= FILL_MIN;
}

function matchesTemplate(got: [number, number], want: [number, number]): boolean {
  const fits = (a: number, b: number) => Math.abs(a - b) <= TOL_IN;
  return (fits(got[0], want[0]) && fits(got[1], want[1]))
    || (fits(got[0], want[1]) && fits(got[1], want[0]));
}

const maps = loadMaps();
const templates = loadTemplates();

interface Slab { key: string; mapId: string; label: string; poly: Pt[]; template?: [number, number] }

const slabs: Slab[] = maps.flatMap((m) =>
  m.features.flatMap((f) =>
    (f.parts as unknown as { role?: string; poly: Pt[] }[])
      .filter((p) => p.role && RUBBLE_ROLES.has(p.role))
      .map((p) => ({
        key: `${m.id}.${f.label}`,
        mapId: m.id,
        label: f.label ?? '?',
        poly: p.poly,
        template: templates.get(`${m.killzone}|${f.label}`),
      })),
  ),
);

/** Why this slab is wrong, or null if it holds the invariant. */
function violation(s: Slab): string | null {
  if (!isRect(s.poly)) {
    const [w, h] = extent(s.poly);
    return `${s.poly.length} vertices filling ${(area(s.poly) / (w * h)).toFixed(2)} of their `
      + 'bounding box: not a rectangle';
  }
  if (!s.template) return 'no template footprint in data/terrain';
  const got = extent(s.poly);
  if (!matchesTemplate(got, s.template)) {
    return `bbox ${got[0].toFixed(3)} x ${got[1].toFixed(3)} does not match template `
      + `${s.template[0].toFixed(3)} x ${s.template[1].toFixed(3)} within ${TOL_IN}"`;
  }
  return null;
}

describe.skipIf(maps.length === 0)('rubble pieces are rectangles', () => {
  it('finds rubble on every killzone that prints it', () => {
    expect(slabs.length).toBeGreaterThan(0);
    for (const kz of ['volkus', 'tomb-world']) {
      expect(slabs.filter((s) => s.mapId.startsWith(kz)).length).toBeGreaterThan(0);
    }
  });

  it('gives every rubble part four corners at its template size', () => {
    const broken = slabs
      .filter((s) => !(s.key in PENDING))
      .map((s) => ({ s, why: violation(s) }))
      .filter((r) => r.why)
      .map((r) => `${r.s.key}: ${r.why}`);
    expect(broken).toEqual([]);
  });

  it('keeps the pending list honest — an entry that now passes must be deleted', () => {
    const fixed = Object.keys(PENDING).filter((key) => {
      const mine = slabs.filter((s) => s.key === key);
      return mine.length > 0 && mine.every((s) => violation(s) === null);
    });
    expect(fixed).toEqual([]);
  });

  it('names a feature that actually exists for every pending entry', () => {
    const unknown = Object.keys(PENDING).filter((key) => !slabs.some((s) => s.key === key));
    expect(unknown).toEqual([]);
  });
});
