/**
 * Fixtures for the AI soak + strength tests.
 *
 * Synthetic killzones with real terrain (cover, obscuring blocks, Vantage, a Close Quarters
 * layout), synthetic datacards, and a synthetic scoring op.
 *
 * WHY A SYNTHETIC OP: `src/core/ops/**` (the real crit/tac/kill ops) is owned by another
 * agent and was not available when the AI landed. Without a scoring hook every game is a 0-0
 * draw, so the win-rate tests would measure nothing. `secureAndSlayOp` awards VP for objective
 * control and for kills — the two things Approved Ops actually pays for — through the same
 * `onEndOfTP` / `state.teams[].vp` channel the real ops use.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeContext, type GameContext, type OpDef } from '../../src/core/context.ts';
import { SeededRng } from '../../src/core/rng.ts';
import { aliveOperatives, log, markerController } from '../../src/core/state.ts';
import { parseWeaponRules } from '../../src/core/weaponRules.ts';
import { otherPlayer, type Datacard, type KillzoneMap, type PlayerId, type TerrainFeature } from '../../src/core/types.ts';
import type { RosterSpec } from '../../src/ai/runner.ts';
import { heavyBlock, makeCard, rect, testMap, vantagePlatform } from '../fixtures.ts';

// ---------------------------------------------------------------------------
// Datacards
// ---------------------------------------------------------------------------

export function aiDatacards(): Datacard[] {
  const trooper = makeCard({ id: 'ai.trooper', name: 'TROOPER' });
  const gunner = makeCard({
    id: 'ai.gunner',
    name: 'GUNNER',
    wounds: 11,
    weapons: [
      {
        name: 'assault cannon',
        profiles: [
          { type: 'ranged', atk: 5, hit: 3, dmgN: 3, dmgC: 4, rules: parseWeaponRules('Piercing Crits 1, Balanced') },
        ],
      },
      { name: 'gun butt', profiles: [{ type: 'melee', atk: 3, hit: 5, dmgN: 2, dmgC: 3, rules: [] }] },
    ],
  });
  const blade = makeCard({
    id: 'ai.blade',
    name: 'BLADE',
    move: 7,
    save: 4,
    wounds: 10,
    weapons: [
      { name: 'bolt pistol', profiles: [{ type: 'ranged', atk: 4, hit: 4, dmgN: 2, dmgC: 3, rules: parseWeaponRules('Range 8"') }] },
      {
        name: 'chainsword',
        profiles: [{ type: 'melee', atk: 5, hit: 3, dmgN: 3, dmgC: 4, rules: parseWeaponRules('Ceaseless') }],
      },
    ],
  });
  const sniper = makeCard({
    id: 'ai.sniper',
    name: 'SNIPER',
    wounds: 9,
    weapons: [
      {
        name: 'long rifle',
        profiles: [
          { type: 'ranged', atk: 4, hit: 3, dmgN: 3, dmgC: 4, rules: parseWeaponRules('Heavy, Devastating 2, Silent') },
        ],
      },
      { name: 'knife', profiles: [{ type: 'melee', atk: 3, hit: 5, dmgN: 2, dmgC: 3, rules: [] }] },
    ],
  });
  return [trooper, gunner, blade, sniper];
}

export const AI_ROSTER: RosterSpec = {
  teamId: 'ai.test',
  operatives: [
    { datacardId: 'ai.gunner' },
    { datacardId: 'ai.trooper' },
    { datacardId: 'ai.blade' },
    { datacardId: 'ai.sniper' },
  ],
};

/** A five-strong roster for the heavier soak runs. */
export const AI_ROSTER_BIG: RosterSpec = {
  teamId: 'ai.test',
  operatives: [...AI_ROSTER.operatives, { datacardId: 'ai.trooper' }],
};

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

/**
 * An open arena with real cover but clear firing lanes: LoS blocks that grant cover and
 * obscure, plus two Vantage platforms. Lanes matter — with no terrain at all, Kill Team
 * weapons have unlimited range and positioning would be meaningless.
 */
export function arenaMap(): KillzoneMap {
  const features: TerrainFeature[] = [
    heavyBlock('a1', 8, 4, 2, 3, 3),
    heavyBlock('a2', 8, 15, 2, 3, 3),
    heavyBlock('b1', 14, 9.5, 2.5, 3, 4),
    heavyBlock('b2', 13.5, 1.5, 2, 2, 2),
    heavyBlock('b3', 13.5, 18.5, 2, 2, 2),
    heavyBlock('c1', 20, 4, 2, 3, 3),
    heavyBlock('c2', 20, 15, 2, 3, 3),
    vantagePlatform('v1', 4, 9.5, 2.5, 3, 3),
    vantagePlatform('v2', 23.5, 9.5, 2.5, 3, 3),
  ];
  return testMap({ id: 'ai-arena', name: 'AI arena', features });
}

/** A tighter board that exercises cover-vs-obscured and charges. */
export function corridorMap(): KillzoneMap {
  const features: TerrainFeature[] = [
    heavyBlock('w1', 9, 0, 1.5, 7, 4),
    heavyBlock('w2', 9, 14, 1.5, 8, 4),
    heavyBlock('w3', 19.5, 0, 1.5, 8, 4),
    heavyBlock('w4', 19.5, 15, 1.5, 7, 4),
    heavyBlock('m1', 14, 9.5, 2, 3, 2),
  ];
  return testMap({ id: 'ai-corridor', name: 'AI corridor', features });
}

/**
 * Close Quarters (`map.closeQuarters`) so the soak exercises Guard / On Guard interrupts and
 * Condensed Environment weapon rules — gated to Gallowdark and Tomb World (docs/DECISIONS.md
 * D-002), so the killzone id is set accordingly.
 */
export function closeQuartersMap(): KillzoneMap {
  const wall = (id: string, x: number, y: number, w: number, h: number): TerrainFeature => ({
    id,
    kind: 'gallowdark.wall',
    label: id.toUpperCase(),
    placement: { x, y, rotDeg: 0, flip: false },
    parts: [
      {
        id: `${id}.body`,
        featureId: id,
        poly: rect(x, y, w, h),
        z0: 0,
        z1: 4,
        types: ['Wall', 'Heavy'],
        role: 'wall',
        solid: true,
        blocksVisibility: true,
      },
    ],
  });
  return testMap({
    id: 'ai-gallowdark',
    name: 'AI boarding action',
    killzone: 'gallowdark',
    closeQuarters: true,
    features: [wall('g1', 10, 0, 0.5, 8), wall('g2', 10, 13, 0.5, 9), wall('g3', 19, 0, 0.5, 9), wall('g4', 19, 14, 0.5, 8)],
  });
}

export function syntheticMaps(): KillzoneMap[] {
  return [arenaMap(), corridorMap(), closeQuartersMap()];
}

/**
 * Real extracted maps, if `data/maps/**` exists yet (another agent generates them). Returns an
 * empty list otherwise so the soak skips them gracefully.
 */
export function realMaps(limit = 3): KillzoneMap[] {
  const root = join(process.cwd(), 'data', 'maps');
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_')) files.push(full);
    }
  };
  walk(root, 0);

  // One map per killzone first, so a sample covers Volkus / Bheta-Decima / Gallowdark / Tomb.
  const byKillzone = new Map<string, KillzoneMap>();
  const rest: KillzoneMap[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as KillzoneMap;
      if (!parsed?.board || !parsed.dropZones?.p1 || !Array.isArray(parsed.features)) continue;
      if (!byKillzone.has(parsed.killzone)) byKillzone.set(parsed.killzone, parsed);
      else rest.push(parsed);
    } catch {
      // A half-written or differently-shaped file is skipped, not fatal.
    }
  }
  return [...byKillzone.values(), ...rest].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Scoring op
// ---------------------------------------------------------------------------

export const SCORING_OP_ID = 'ai.secure-and-slay';

/**
 * Synthetic crit op: at the end of each turning point score 1VP per objective marker you
 * control (max 2) and 1VP per enemy operative incapacitated since the last turning point.
 */
export function secureAndSlayOp(getCtx: () => GameContext): OpDef {
  return {
    id: SCORING_OP_ID,
    kind: 'crit',
    name: 'Secure and Slay',
    text: 'End of each turning point: 1VP per objective marker you control (max 2VP), and 2VP per enemy operative incapacitated during that turning point.',
    register(reg, player: PlayerId) {
      reg.on(
        'onEndOfTP',
        { id: `${SCORING_OP_ID}:${player}`, sourceText: 'Synthetic scoring op used by the AI tests.', player },
        (ev) => {
          const state = ev.state;
          const ctx = getCtx();
          let controlled = 0;
          for (const marker of Object.values(state.markers)) {
            if (marker.kind !== 'objective') continue;
            if (markerController(ctx, state, marker) === player) controlled++;
          }
          const secure = Math.min(2, controlled);
          const enemy = otherPlayer(player);
          const dead = state.teams[enemy].startingSize - aliveOperatives(state, enemy).length;
          const scratch = (state.opState[SCORING_OP_ID] ??= {}) as Record<string, number>;
          const seen = scratch[`kills:${player}`] ?? 0;
          const killVp = 2 * Math.max(0, dead - seen);
          scratch[`kills:${player}`] = dead;
          const vp = secure + killVp;
          if (vp <= 0) return;
          state.teams[player].vp += vp;
          const byOp = (state.teams[player].vpByOp[SCORING_OP_ID] ??= []);
          byOp.push(vp);
          log(state, {
            kind: 'score',
            player,
            text: `${SCORING_OP_ID}: +${vp}VP (${secure} secure, ${killVp} kills)`,
          });
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export function aiContext(seed = 1): GameContext {
  const ctx = makeContext({ rng: new SeededRng(seed) });
  for (const card of aiDatacards()) ctx.datacards.set(card.id, card);
  for (const map of syntheticMaps()) ctx.maps.set(map.id, map);
  ctx.ops.set(SCORING_OP_ID, secureAndSlayOp(() => ctx));
  return ctx;
}
