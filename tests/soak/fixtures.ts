/**
 * Fixtures for the AI soak + strength tests.
 *
 * Synthetic killzones with real terrain (cover, obscuring blocks, Vantage, a Close Quarters
 * layout), synthetic datacards, and a synthetic scoring op.
 *
 * Contexts come from `createGameContext`, so games are played with the REAL ops layer wired
 * in (crit op scoring, the kill op, tac ops, initiative cards and equipment) — an acceptance
 * run against a bare `makeContext` would be measuring a game with nothing to score.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameContext } from '../../src/core/context.ts';
import { createGameContext } from '../../src/core/game.ts';
import { SeededRng } from '../../src/core/rng.ts';
import { parseWeaponRules } from '../../src/core/weaponRules.ts';
import { hasEffect, type TeamModule } from '../../src/core/hooks.ts';
import type { Datacard, KillzoneMap, TerrainFeature } from '../../src/core/types.ts';
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
// Ops + context
// ---------------------------------------------------------------------------

/**
 * A minimal kill team module, so the AI is exercised against the same seam a real team uses:
 * a firefight ploy priced by `aiHints.ployValue`, and role hints.
 */
export const aiTeamModule: TeamModule = {
  id: 'ai.test',
  register(reg, player) {
    reg.on(
      'onStatMod',
      { id: `ai.test.grit:${player}`, sourceText: 'Test team rule: +1 Save while the Bulwark ploy is active.', player },
      (ev) => {
        if (ev.operative.player !== player) return;
        if (hasEffect(ev.state, 'ai.test.bulwark', { player })) ev.mods.save += 1;
      },
    );
  },
  ploys: [
    {
      id: 'ai.bulwark',
      name: 'Bulwark',
      kind: 'firefight',
      cp: 1,
      text: 'Improve the Save stat of friendly operatives by 1 until the end of the turning point.',
      usable: (state, player) => ({ ok: !hasEffect(state, 'ai.test.bulwark', { player }) }),
    },
  ],
  equipment: [],
  aiHints: {
    roles: { 'ai.blade': 'melee', 'ai.sniper': 'sniper', 'ai.gunner': 'gunner', 'ai.trooper': 'objective' },
    ployValue: { 'ai.bulwark': 12 },
  },
};

/** Crit op used by the AI tests: Secure — objective control, the bread and butter of KT. */
export const CRIT_OP_ID = 'crit.secure';

/** Tac ops for each side. Both teams have no archetypes, so any tac op is selectable. */
export const TAC_OP_P1 = 'tac.dominate';
export const TAC_OP_P2 = 'tac.rout';

export function aiContext(seed = 1, withTeam = false): GameContext {
  return createGameContext({
    rng: new SeededRng(seed),
    datacards: aiDatacards(),
    maps: syntheticMaps(),
    ...(withTeam ? { teams: [aiTeamModule] } : {}),
  });
}
