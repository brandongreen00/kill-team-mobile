/**
 * Gallowdark and Tomb World: square corners, and doors that are doors.
 *
 * The Close Quarters map cards draw a wall run as a 9px bar and every point where a physical
 * wall PIECE ends as a 27px square block — the connector post the sections slot into. The
 * extractor used to emit only the bars, running node centre to node centre, so wherever two
 * runs met at a right angle the union of the two bars left a quarter-block hole: 0.365" of
 * bar on each side of a node, meeting over only half of that square. That hole is a real gap
 * in Wall terrain — a line of sight through the corner of a sealed room — and it is what the
 * board drew.
 *
 * These are the invariants that hole broke, asserted against the shipped data:
 *
 *   1. every wall-piece end carries a joint block;
 *   2. wherever a horizontal and a vertical bar cross, the whole crossing square is solid;
 *   3. every joint block is the same square, and the ones on the board edge are the only
 *      ones that are not (they are clipped by the killzone edge, which is what the card
 *      prints too);
 *   4. every wall piece carries a printed letter, and no card uses more of a piece than the
 *      killzone's printed inventory holds;
 *   5. an access point's `opensAs` matches the printed killzone key — on Gallowdark A3, A4,
 *      B2 and B3 have hatchways and nothing has a breach point; on Tomb World A1 and B2 have
 *      BREACH POINTS and A3, A4 and B3 have hatchways.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KillzoneMap, TerrainPart, Vec2 } from '../src/core/types.ts';

const MAPS_DIR = join(process.cwd(), 'data', 'maps');

const load = (kz: string): KillzoneMap[] =>
  readdirSync(join(MAPS_DIR, kz))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(MAPS_DIR, kz, f), 'utf8')) as KillzoneMap);

const maps = [...load('gallowdark'), ...load('tomb-world')];

/** The printed connector block: 27 card px against a 94 px lattice square of 3.8125". */
const BLOCK_IN = (27 / 94) * 3.8125;
/** The printed wall bar: 9 card px on the same scale. */
const BAR_IN = (9 / 94) * 3.8125;
const TOL = 0.01;

/** The printed killzone inventories (Killzones rules page + the killzone keys). */
const INVENTORY: Record<string, Record<string, number>> = {
  gallowdark: { A1: 2, A2: 2, A3: 2, A4: 2, B1: 2, B2: 2, B3: 4 },
  'tomb-world': {
    A1: 2, A2: 2, A3: 2, A4: 2, B1: 2, B2: 2, B3: 2, B4: 2,
    C1: 1, C2: 1, C3: 1, C4: 1, C5: 1, T: 2,
  },
};

/** What the killzone key says each wall piece is cut with. */
const ACCESS: Record<string, Record<string, 'hatch' | 'breachWall' | undefined>> = {
  // keys/CQ_KillzoneGallowdark1.png + 2: "Long Wall With Hatchway", "Short Wall With Hatchway".
  gallowdark: { A1: undefined, A2: undefined, A3: 'hatch', A4: 'hatch', B1: undefined, B2: 'hatch', B3: 'hatch' },
  // keys/TW1.jpg + TW2.jpg: "LONG WALL WITH BREACH POINT" (A1), "SHORT WALL WITH BREACH POINT" (B2).
  'tomb-world': {
    A1: 'breachWall', A2: undefined, A3: 'hatch', A4: 'hatch',
    B1: undefined, B2: 'breachWall', B3: 'hatch', B4: undefined,
  },
};

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const bbox = (poly: readonly Vec2[]): Box => ({
  x0: Math.min(...poly.map((p) => p.x)),
  y0: Math.min(...poly.map((p) => p.y)),
  x1: Math.max(...poly.map((p) => p.x)),
  y1: Math.max(...poly.map((p) => p.y)),
});

const inside = (b: Box, p: Vec2): boolean =>
  p.x >= b.x0 - 1e-9 && p.x <= b.x1 + 1e-9 && p.y >= b.y0 - 1e-9 && p.y <= b.y1 + 1e-9;

/** Every part that is physically the wall structure: bars, joints, and a closed access point. */
const WALL_ROLES = new Set(['wall', 'connector', 'wallEnd', 'accessPoint']);

function wallParts(m: KillzoneMap): (TerrainPart & { label?: string })[] {
  const out: (TerrainPart & { label?: string })[] = [];
  for (const f of m.features) {
    for (const p of f.parts) {
      if (WALL_ROLES.has(p.role ?? '')) out.push({ ...p, label: f.label });
    }
  }
  return out;
}

describe('close-quarters killzones', () => {
  it('there is a Gallowdark and a Tomb World map to check', () => {
    expect(maps.map((m) => m.id)).toHaveLength(12);
    expect(maps.every((m) => m.closeQuarters)).toBe(true);
  });

  for (const m of maps) {
    describe(m.id, () => {
      const parts = wallParts(m);
      // A joint block is a PART of the wall piece whose end lands on it, not a feature of its
      // own — see the note in `data/terrain/<killzone>.json`.
      const joints = parts.filter((p) => p.role === 'connector' || p.role === 'wallEnd');
      const bars = parts.filter((p) => p.role === 'wall' || p.role === 'accessPoint');

      it('every wall-piece end carries a joint block, or runs off the killzone', () => {
        const jointBoxes = joints.map((p) => bbox(p.poly));
        // The two ends of a run are the ends of the piece it belongs to, so they are found
        // from the FEATURE's extent rather than from a single bar: an access point notches a
        // piece into two bars plus the opening.
        for (const f of m.features) {
          const own = f.parts.filter((p) => p.role === 'wall' || p.role === 'accessPoint');
          if (own.length === 0) continue;
          const b = bbox(own.flatMap((p) => p.poly));
          const horiz = b.x1 - b.x0 >= b.y1 - b.y0;
          const cy = (b.y0 + b.y1) / 2;
          const cx = (b.x0 + b.x1) / 2;
          for (const end of horiz ? [{ x: b.x0, y: cy }, { x: b.x1, y: cy }] : [{ x: cx, y: b.y0 }, { x: cx, y: b.y1 }]) {
            const onEdge =
              end.x <= TOL || end.y <= TOL || end.x >= m.board.w - TOL || end.y >= m.board.h - TOL;
            const covered = jointBoxes.some((jb) => inside(jb, end));
            // A piece may also end by butting into the side of another run, where the card
            // prints no post because there is nothing to slot into.
            const abuts = bars.some((p) => p.id !== f.parts[0]!.id && inside(bbox(p.poly), end));
            expect(
              covered || abuts || onEdge,
              `${f.id} end (${end.x.toFixed(3)}, ${end.y.toFixed(3)}) has no joint block`,
            ).toBe(true);
          }
        }
      });

      it('a corner where two walls meet is square', () => {
        const boxes = parts.map((p) => bbox(p.poly));
        const horiz = boxes.filter((b) => b.x1 - b.x0 > b.y1 - b.y0);
        const vert = boxes.filter((b) => b.y1 - b.y0 > b.x1 - b.x0);
        let corners = 0;
        for (const h of horiz) {
          for (const v of vert) {
            // The square where the two bars' centrelines cross.
            const s: Box = { x0: v.x0, y0: h.y0, x1: v.x1, y1: h.y1 };
            if (s.x1 - s.x0 > BAR_IN + TOL || s.y1 - s.y0 > BAR_IN + TOL) continue;
            // Both bars have to actually reach it, or they are two unrelated walls.
            if (h.x1 < s.x0 - TOL || h.x0 > s.x1 + TOL) continue;
            if (v.y1 < s.y0 - TOL || v.y0 > s.y1 + TOL) continue;
            corners += 1;
            const e = 0.02;
            for (const q of [
              { x: s.x0 + e, y: s.y0 + e },
              { x: s.x1 - e, y: s.y0 + e },
              { x: s.x0 + e, y: s.y1 - e },
              { x: s.x1 - e, y: s.y1 - e },
            ]) {
              expect(
                boxes.some((b) => inside(b, q)),
                `${m.id}: the corner at (${((s.x0 + s.x1) / 2).toFixed(3)}, ${((s.y0 + s.y1) / 2).toFixed(3)}) ` +
                  `is notched at (${q.x.toFixed(3)}, ${q.y.toFixed(3)})`,
              ).toBe(true);
            }
          }
        }
        expect(corners, `${m.id} has no wall crossings at all`).toBeGreaterThan(0);
      });

      it('every joint block is one printed square, clipped only by the killzone edge', () => {
        expect(joints.length).toBeGreaterThan(0);
        for (const p of joints) {
          const b = bbox(p.poly);
          const w = b.x1 - b.x0;
          const h = b.y1 - b.y0;
          const clipped = b.x0 <= TOL || b.y0 <= TOL || b.x1 >= m.board.w - TOL || b.y1 >= m.board.h - TOL;
          if (!clipped) {
            expect(w).toBeCloseTo(BLOCK_IN, 2);
            expect(h).toBeCloseTo(BLOCK_IN, 2);
          } else {
            expect(w).toBeLessThanOrEqual(BLOCK_IN + TOL);
            expect(h).toBeLessThanOrEqual(BLOCK_IN + TOL);
          }
          // "Operatives cannot move over or through Wall terrain" — a post is wall, or it is
          // a 1.1" square an operative may climb (2.362" is inside the 3" climb reach).
          expect(p.types).toEqual(['Heavy', 'Wall']);
          expect(p.solid).toBe(true);
        }
      });

      it('a joint block never becomes a terrain feature of its own', () => {
        // "An operative cannot be in cover from and obscured by the same terrain feature" is
        // keyed on the feature id, so a post that is its own feature would pay out both for
        // one printed wall piece.
        expect(m.features.filter((f) => f.kind.endsWith('.connector') || f.kind.endsWith('.wallEnd'))).toHaveLength(0);
      });

      it('every wall piece carries a printed letter, within the killzone inventory', () => {
        const counts: Record<string, number> = {};
        for (const f of m.features) {
          expect(f.label, `${f.id} has no printed letter`).toBeTruthy();
          expect(f.label).not.toContain('?');
          counts[f.label!] = (counts[f.label!] ?? 0) + 1;
        }
        const inv = INVENTORY[m.killzone]!;
        for (const [label, n] of Object.entries(counts)) {
          expect(inv[label], `${m.id} uses ${label}, which is not in the killzone inventory`).toBeDefined();
          expect(n, `${m.id} uses ${label} ${n}x, inventory has ${inv[label]}`).toBeLessThanOrEqual(inv[label]!);
        }
      });

      it('a hatchway is a hatchway and a breach point is a breach point', () => {
        const key = ACCESS[m.killzone]!;
        for (const f of m.features) {
          const access = f.parts.filter((p) => p.role === 'accessPoint');
          const expected = f.label ? key[f.label] : undefined;
          if (expected === undefined) {
            expect(access, `${f.id} (${f.label}) has an access point the killzone key does not print`).toHaveLength(0);
            continue;
          }
          expect(access.length, `${f.id} (${f.label}) should carry one ${expected}`).toBe(1);
          expect(access[0]!.opensAs).toBe(expected);
          // A closed access point is part of the wall: "Heavy and Wall terrain".
          expect(access[0]!.types).toEqual(['Heavy', 'Wall']);
          expect(access[0]!.state).toBe('closed');
        }
      });
    });
  }

  it('the thirteen printed wall ends are all found', () => {
    // keys/TW3.jpg labels the grey cross "WALL END": a Necron sarcophagus slab capping a run
    // rather than joining two. It is printed on every Tomb World card and on Gallowdark 5 and
    // 6 only, thirteen in all, and it is drawn ON a block — so a detector reading the raw wall
    // ink finds a hole at the node and misses it.
    const ends = (m: KillzoneMap) => wallParts(m).filter((p) => p.role === 'wallEnd').length;
    const found = Object.fromEntries(maps.map((m) => [m.id, ends(m)]));
    expect(found).toEqual({
      'gallowdark-1': 0, 'gallowdark-2': 0, 'gallowdark-3': 0,
      'gallowdark-4': 0, 'gallowdark-5': 2, 'gallowdark-6': 2,
      'tomb-world-1': 1, 'tomb-world-2': 2, 'tomb-world-3': 2,
      'tomb-world-4': 2, 'tomb-world-5': 1, 'tomb-world-6': 1,
    });
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(13);
  });
});
