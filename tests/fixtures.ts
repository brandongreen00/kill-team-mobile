/** Shared test fixtures: a synthetic 30x22 killzone and a couple of datacards. */
import { makeContext, type GameContext } from '../src/core/context.ts';
import { SeededRng, ScriptedRng } from '../src/core/rng.ts';
import { parseWeaponRules } from '../src/core/weaponRules.ts';
import type { Datacard, KillzoneMap, Poly, TerrainFeature } from '../src/core/types.ts';

export const rect = (x: number, y: number, w: number, h: number): Poly => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

export function testMap(overrides: Partial<KillzoneMap> = {}): KillzoneMap {
  return {
    id: 'test-open',
    killzone: 'volkus',
    name: 'Test killzone',
    board: { w: 30, h: 22, grid: 1 },
    closeQuarters: false,
    dropZones: { p1: [rect(0, 0, 6, 22)], p2: [rect(24, 0, 6, 22)] },
    territories: { p1: [rect(0, 0, 15, 22)], p2: [rect(15, 0, 15, 22)] },
    killzoneEdges: { p1: [], p2: [], neutral: [] },
    centreLine: { a: { x: 15, y: 0 }, b: { x: 15, y: 22 } },
    flankLine: { a: { x: 0, y: 11 }, b: { x: 30, y: 11 } },
    objectives: [
      { id: 'p1', kind: 'p1', pos: { x: 8, y: 11 }, z: 0 },
      { id: 'centre', kind: 'centre', pos: { x: 15, y: 11 }, z: 0 },
      { id: 'p2', kind: 'p2', pos: { x: 22, y: 11 }, z: 0 },
    ],
    features: [],
    source: { card: 'synthetic', pxPerInch: 24, extractedAt: '2026-01-01', tool: 'tests/fixtures.ts' },
    ...overrides,
  };
}

/** A solid Heavy block, e.g. for obscured/cover tests. */
export function heavyBlock(id: string, x: number, y: number, w: number, h: number, z1 = 3): TerrainFeature {
  return {
    id,
    kind: 'test.heavy',
    label: id.toUpperCase(),
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      {
        id: `${id}.body`,
        featureId: id,
        poly: rect(x, y, w, h),
        z0: 0,
        z1,
        types: ['Heavy'],
        role: 'wall',
      },
    ],
  };
}

/** A Vantage platform on legs — the classic elevation case. */
export function vantagePlatform(id: string, x: number, y: number, w: number, h: number, z = 3): TerrainFeature {
  return {
    id,
    kind: 'test.vantage',
    label: id.toUpperCase(),
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      {
        id: `${id}.floor`,
        featureId: id,
        poly: rect(x, y, w, h),
        z0: z,
        z1: z,
        types: ['Vantage', 'Accessible'],
        role: 'floor',
        standable: true,
        blocksVisibility: false,
        solid: false,
      },
    ],
  };
}

export function makeCard(over: Partial<Datacard> & { id: string; name: string }): Datacard {
  return {
    teamId: 'test',
    keywords: [],
    base: { shape: 'round', mm: 32 },
    apl: 2,
    move: 6,
    save: 4,
    wounds: 10,
    weapons: [
      {
        name: 'lasgun',
        profiles: [{ type: 'ranged', atk: 4, hit: 4, dmgN: 2, dmgC: 3, rules: parseWeaponRules('') }],
      },
      {
        name: 'fists',
        profiles: [{ type: 'melee', atk: 3, hit: 4, dmgN: 2, dmgC: 3, rules: [] }],
      },
    ],
    abilities: [],
    uniqueActions: [],
    ...over,
  };
}

export function testContext(opts: { seed?: number; script?: number[] } = {}): GameContext {
  const rng = opts.script ? new ScriptedRng(opts.script) : new SeededRng(opts.seed ?? 1);
  const ctx = makeContext({ rng });
  const trooper = makeCard({ id: 'test.trooper', name: 'TROOPER' });
  const heavy = makeCard({
    id: 'test.heavyGunner',
    name: 'HEAVY GUNNER',
    base: { shape: 'round', mm: 40 },
    wounds: 12,
    weapons: [
      {
        name: 'heavy stubber',
        profiles: [
          { type: 'ranged', atk: 5, hit: 3, dmgN: 3, dmgC: 4, rules: parseWeaponRules('Heavy, Piercing Crits 1') },
        ],
      },
      { name: 'gun butt', profiles: [{ type: 'melee', atk: 3, hit: 5, dmgN: 2, dmgC: 3, rules: [] }] },
    ],
  });
  ctx.datacards.set(trooper.id, trooper);
  ctx.datacards.set(heavy.id, heavy);
  const map = testMap();
  ctx.maps.set(map.id, map);
  return ctx;
}
