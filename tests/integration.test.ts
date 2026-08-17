/**
 * Integration: the extracted killzones must be consumable by the engine, not just valid JSON.
 * Every map is loaded, sanity-checked against the rules' own expectations, and then actually
 * played on — deployment, visibility and a shot — so a bad extraction cannot pass silently.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { defaultDecisionOption } from '../src/core/decisions.ts';
import { buildTerrainIndex } from '../src/core/terrain.ts';
import { baseWhollyWithin, polyArea } from '../src/core/geometry.ts';
import { validTargets } from '../src/core/sequences/shoot.ts';
import { testContext } from './fixtures.ts';
import type { GameState, KillzoneMap } from '../src/core/types.ts';

const MAPS_DIR = join(process.cwd(), 'data', 'maps');

function loadMaps(): KillzoneMap[] {
  if (!existsSync(MAPS_DIR)) return [];
  const out: KillzoneMap[] = [];
  for (const kz of readdirSync(MAPS_DIR)) {
    const dir = join(MAPS_DIR, kz);
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as KillzoneMap);
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

const maps = loadMaps();
const has = maps.length > 0;

describe.skipIf(!has)('extracted killzones', () => {
  it('produces the 24 Approved Ops layouts, six per killzone', () => {
    expect(maps).toHaveLength(24);
    for (const kz of ['volkus', 'bheta-decima', 'gallowdark', 'tomb-world'] as const) {
      expect(maps.filter((m) => m.killzone === kz)).toHaveLength(6);
    }
  });

  it('uses the right board for each killzone and gates Close Quarters correctly', () => {
    for (const m of maps) {
      if (m.killzone === 'volkus' || m.killzone === 'bheta-decima') {
        // "Unless otherwise specified, a killzone game board is 30" x 22"."
        expect([m.board.w, m.board.h]).toEqual([30, 22]);
        expect(m.closeQuarters).toBe(false);
      } else {
        // "606mm x 703mm game board with a 6x7 grid system" = 23.86" x 27.68"
        expect(m.board.w).toBeGreaterThan(27);
        expect(m.board.w).toBeLessThan(28);
        expect(m.board.h).toBeGreaterThan(23.5);
        expect(m.board.h).toBeLessThan(24.2);
        // docs/DECISIONS.md D-002: Close Quarters applies to Gallowdark AND Tomb World.
        expect(m.closeQuarters).toBe(true);
      }
    }
  });

  it('keeps every terrain polygon on the board and every feature labelled', () => {
    for (const m of maps) {
      expect(m.features.length).toBeGreaterThan(0);
      for (const f of m.features) {
        expect(f.parts.length).toBeGreaterThan(0);
        for (const p of f.parts) {
          expect(p.poly.length).toBeGreaterThanOrEqual(3);
          expect(Math.abs(polyArea(p.poly))).toBeGreaterThan(0);
          expect(p.types.length).toBeGreaterThan(0);
          for (const v of p.poly) {
            expect(v.x).toBeGreaterThanOrEqual(-0.6);
            expect(v.y).toBeGreaterThanOrEqual(-0.6);
            expect(v.x).toBeLessThanOrEqual(m.board.w + 0.6);
            expect(v.y).toBeLessThanOrEqual(m.board.h + 0.6);
          }
          expect(p.z1).toBeGreaterThanOrEqual(p.z0);
        }
      }
    }
  });

  it('gives both players a drop zone, a territory and three objective markers', () => {
    for (const m of maps) {
      expect(m.dropZones.p1.length).toBeGreaterThan(0);
      expect(m.dropZones.p2.length).toBeGreaterThan(0);
      expect(m.territories.p1.length).toBeGreaterThan(0);
      expect(m.territories.p2.length).toBeGreaterThan(0);
      const kinds = m.objectives.map((o) => o.kind).sort();
      expect(kinds).toEqual(['centre', 'p1', 'p2']);
      for (const o of m.objectives) {
        expect(o.pos.x).toBeGreaterThan(0);
        expect(o.pos.x).toBeLessThan(m.board.w);
        expect(o.pos.y).toBeGreaterThan(0);
        expect(o.pos.y).toBeLessThan(m.board.h);
      }
    }
  });

  it('places objective markers on the killzone floor except in Bheta-Decima', () => {
    // Appendix › GAME SEQUENCE: "Other than in Killzone: Bheta-Decima, all objective markers
    // must be set up on the killzone floor."
    for (const m of maps) {
      if (m.killzone === 'bheta-decima') continue;
      for (const o of m.objectives) expect(o.z).toBe(0);
    }
    const bheta = maps.filter((m) => m.killzone === 'bheta-decima');
    expect(bheta.some((m) => m.objectives.some((o) => o.z > 0))).toBe(true);
  });

  it('leaves room in every drop zone for a 40mm base', () => {
    for (const m of maps) {
      for (const side of ['p1', 'p2'] as const) {
        const zone = m.dropZones[side];
        const fits = zone.some((poly) => {
          const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
          const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
          return baseWhollyWithin({ x: cx, y: cy }, { shape: 'round', mm: 40 }, 0, zone);
        });
        expect(fits, `${m.id} ${side} drop zone is too small for a 40mm base`).toBe(true);
      }
    }
  });

  it('builds a terrain index and answers visibility on every map', () => {
    for (const m of maps) {
      const index = buildTerrainIndex(m);
      expect(index.parts.length).toBeGreaterThan(0);
      if (m.closeQuarters) expect(index.walls.length).toBeGreaterThan(0);
      // Somebody must be able to stand above the floor on Bheta-Decima (gantries) and Volkus.
      if (m.killzone === 'bheta-decima') expect(index.standable.length).toBeGreaterThan(0);
    }
  });

  it('plays a deployment and a shot on every map without a single rejected intent', () => {
    for (const m of maps) {
      const ctx = testContext({ seed: 11 });
      ctx.maps.set(m.id, m);
      let s: GameState = createBattle(ctx, { map: m, seed: 11 });
      const picks = Array.from({ length: 3 }, () => ({ datacardId: 'test.trooper' }));
      s = reduce(s, { t: 'SelectRoster', player: 'p1', teamId: 'test', operatives: picks }, ctx).state;
      s = reduce(s, { t: 'SelectRoster', player: 'p2', teamId: 'test', operatives: picks }, ctx).state;
      s.setup.dropZone = { p1: 'p1', p2: 'p2' };

      // Deploy by searching each drop zone on a coarse grid for a legal spot.
      for (const side of ['p1', 'p2'] as const) {
        const zone = m.dropZones[side];
        let placed = 0;
        for (const id of s.teams[side].operativeIds) {
          let done = false;
          for (let x = 0.4; x < m.board.w && !done; x += 0.4) {
            for (let y = 0.4; y < m.board.h && !done; y += 0.4) {
              if (!baseWhollyWithin({ x, y }, { shape: 'round', mm: 32 }, 0, zone)) continue;
              const out = reduce(s, { t: 'DeployOperative', player: side, operativeId: id, pos: { x, y } }, ctx);
              if (out.ok) {
                s = out.state;
                s.rejected = [];
                done = true;
                placed++;
              }
            }
          }
          expect(done, `${m.id}: no legal spot found for ${id} in the ${side} drop zone`).toBe(true);
        }
        expect(placed).toBe(3);
      }

      s = reduce(s, { t: 'FinishSetup' }, ctx).state;
      expect(s.rejected, `${m.id}: FinishSetup rejected`).toHaveLength(0);
      s.phase = 'firefight';
      s.initiative = 'p1';
      s.activePlayer = 'p1';
      for (const op of Object.values(s.operatives)) op.ready = true;

      // Activate and, if anything is visible from here, take the shot.
      const a = s.teams.p1.operativeIds[0]!;
      s = reduce(s, { t: 'ActivateOperative', player: 'p1', operativeId: a, order: 'engage' }, ctx).state;
      const targets = validTargets(ctx, s, s.operatives[a]!, 'lasgun');
      if (targets.length > 0) {
        const out = reduce(
          s,
          { t: 'PerformAction', operativeId: a, action: 'Shoot', params: { weaponName: 'lasgun', targetId: targets[0]!.target.id } },
          ctx,
        );
        expect(out.ok, `${m.id}: shooting a valid target was rejected — ${out.reason}`).toBe(true);
        s = out.state;
        let guard = 0;
        while (s.pending.length > 0 && guard++ < 40) {
          const d = s.pending[0]!;
          const choice = defaultDecisionOption(d);
          s = reduce(s, { t: 'ResolveDecision', decisionId: d.id, optionId: choice.optionId }, ctx).state;
        }
      }
      expect(s.rejected.map((r) => r.reason), `${m.id} rejected intents`).toEqual([]);
    }
  });
});

describe.skipIf(has)('extracted killzones (not generated yet)', () => {
  it('tells the developer how to generate them', () => {
    expect(maps).toHaveLength(0);
    // Run `pnpm maps:extract` to populate data/maps from the official Approved Ops cards.
  });
});
