/**
 * A Volkus stronghold's Vantage levels can see out.
 *
 * Killzones § Stronghold A: "The upper level(s) of a stronghold terrain feature is Ceiling and
 * Vantage terrain." Killzones § Vantage is what makes climbing one worth doing — Accurate 1 at
 * 2" of elevation, Accurate 2 at 4", and cover denied to operatives below.
 *
 * The map cards trace a stronghold's wall as one ink ring with no height of its own, so the
 * extractor used to extrude every wall part to the PIECE's maximum height — 5.906" for
 * Stronghold A, 7.48" for Stronghold B — while the Vantage floors those rings enclose sit at
 * 3.0" and 6.0". The edge of every upper level was therefore a 2.9"/4.5" opaque Heavy parapet:
 * measured on the shipped data, the best spot on volkus-1 Stronghold A's roof saw 31 of 568
 * killzone-floor positions, 5%. Climbing the two biggest features on all six maps was a pure
 * downside and Vantage's Accurate bonus was unreachable from them.
 *
 * `cap_stronghold_walls` in tools/maps/extract_cards.py now bands each wall bar at 1" above the
 * highest floor of its own feature that the bar borders (docs/DECISIONS.md D-101), and on
 * Stronghold A that last inch is a rampart rather than wall, per § Stronghold F.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTerrainIndex, surfaceAt } from '../src/core/terrain.ts';
import { isVisible } from '../src/core/visibility.ts';
import type { KillzoneMap, TerrainPart, Vec2 } from '../src/core/types.ts';

const DIR = join(process.cwd(), 'data', 'maps', 'volkus');
const PARAPET = 1.0;
/** A traced wall is ~0.21" thick; this reaches the floor it stands against. */
const PAD = 0.35;
const BASE = { shape: 'round' as const, mm: 32 };
const MODEL_HEIGHT = 1.6;

const maps: KillzoneMap[] = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as KillzoneMap)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  : [];

const bbox = (poly: readonly Vec2[]) => ({
  x0: Math.min(...poly.map((p) => p.x)), x1: Math.max(...poly.map((p) => p.x)),
  y0: Math.min(...poly.map((p) => p.y)), y1: Math.max(...poly.map((p) => p.y)),
});
const touches = (a: ReturnType<typeof bbox>, b: ReturnType<typeof bbox>) =>
  a.x0 - PAD <= b.x1 && a.x1 + PAD >= b.x0 && a.y0 - PAD <= b.y1 && a.y1 + PAD >= b.y0;

interface Level { map: KillzoneMap; featureId: string; kind: string; z: number; floor: TerrainPart }

const strongholds = maps.flatMap((m) =>
  m.features.filter((f) => f.kind.startsWith('volkus.stronghold')).map((f) => ({ m, f })),
);
const levels: Level[] = strongholds.flatMap(({ m, f }) =>
  f.parts
    .filter((p) => (p as { role?: string }).role === 'floor')
    .map((floor) => ({ map: m, featureId: f.id, kind: f.kind, z: floor.z1, floor })),
);

describe.skipIf(maps.length === 0)('Volkus stronghold Vantage levels', () => {
  it('finds both strongholds on all six maps', () => {
    expect(maps).toHaveLength(6);
    expect(strongholds).toHaveLength(12);
    expect(levels).toHaveLength(18); // A has one upper level, B has two
  });

  it('"The upper level(s) of a stronghold terrain feature is Ceiling and Vantage terrain"', () => {
    for (const l of levels) {
      expect(new Set(l.floor.types)).toEqual(new Set(['Ceiling', 'Vantage', 'Light']));
    }
  });

  it('caps every wall bar 1" above the highest floor of its own feature that it borders', () => {
    const over: string[] = [];
    for (const { m, f } of strongholds) {
      const floors = f.parts.filter((p) => (p as { role?: string }).role === 'floor');
      const lowest = Math.min(...floors.map((p) => p.z1));
      for (const part of f.parts) {
        const role = (part as { role?: string }).role;
        if (role !== 'wall' && role !== 'door' && role !== 'rampart') continue;
        const wb = bbox(part.poly);
        const bordering = floors.filter((p) => touches(bbox(p.poly), wb)).map((p) => p.z1);
        const allowed = (bordering.length > 0 ? Math.max(...bordering) : lowest) + PARAPET;
        if (part.z1 > allowed + 1e-6) {
          over.push(`${m.id} ${f.id} ${role} z1 ${part.z1} > ${allowed}`);
        }
      }
    }
    expect(over).toEqual([]);
  });

  it('§ Stronghold F: "The small broken ramparts on the edge of the Vantage terrain of Stronghold A are Insignificant and Exposed terrain"', () => {
    // ...and § Stronghold ends "All other parts of it are Heavy terrain", so Stronghold B gets
    // a Heavy parapet and no ramparts. The distinction is the rules', not a modelling choice.
    for (const { m, f } of strongholds) {
      const ramparts = f.parts.filter((p) => (p as { role?: string }).role === 'rampart');
      if (f.kind === 'volkus.strongholdA') {
        expect(ramparts.length, `${m.id} ${f.id}`).toBeGreaterThan(0);
        for (const r of ramparts) {
          expect(new Set(r.types)).toEqual(new Set(['Insignificant', 'Exposed']));
          // Insignificant + Exposed is neither solid nor a blocker, which is the whole point:
          // an operative on the roof looks straight over it.
          expect(r.blocksVisibility).toBe(false);
          expect(r.solid).toBe(false);
          expect(r.z1 - r.z0).toBeCloseTo(PARAPET, 6);
        }
      } else {
        expect(ramparts, `${m.id} ${f.id}`).toEqual([]);
      }
    }
  });

  it('leaves a spot on every Vantage level that can see a fifth of the killzone floor', () => {
    // Measured after the change: 21% (volkus-1 Stronghold B's lower gantry, which sits in the
    // board corner behind a Heavy parapet) up to 68%. Before it, every one of the eighteen
    // levels was between 4% and 18%. The bar is a regression guard, not a target — the
    // structural invariant above is the real assertion.
    const worst: string[] = [];
    for (const l of levels) {
      const idx = buildTerrainIndex(l.map);
      const grid: Vec2[] = [];
      for (let x = 0.5; x < l.map.board.w; x += 1)
        for (let y = 0.5; y < l.map.board.h; y += 1)
          if (surfaceAt(idx, { x, y }) === 0) grid.push({ x, y });
      const need = Math.ceil(grid.length * 0.2);
      const bb = bbox(l.floor.poly);
      let best = 0;
      outer: for (let x = bb.x0 + 0.4; x <= bb.x1; x += 0.6) {
        for (let y = bb.y0 + 0.4; y <= bb.y1; y += 0.6) {
          if (Math.abs(surfaceAt(idx, { x, y }) - l.z) > 0.01) continue;
          const from = { id: 'v', pos: { x, y }, z: l.z, rot: 0, base: BASE, height: MODEL_HEIGHT };
          let seen = 0;
          for (const g of grid) {
            const to = { id: 'g', pos: g, z: 0, rot: 0, base: BASE, height: MODEL_HEIGHT };
            if (isVisible(idx, from, to).visible) seen++;
          }
          if (seen > best) best = seen;
          if (best >= need) break outer; // this level is fine; stop looking
        }
      }
      if (best < need) worst.push(`${l.map.id} ${l.featureId} z=${l.z}: ${best}/${grid.length}`);
    }
    expect(worst).toEqual([]);
  }, 300_000);
});
