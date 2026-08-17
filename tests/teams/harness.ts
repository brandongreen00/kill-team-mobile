/**
 * Shared harness for the kill-team module tests.
 *
 * Builds a GameContext carrying a team's datacards, its TeamModule and its faction equipment,
 * deploys two kill teams on a map and hands back a battle that is ready to activate — so each
 * rule test can set up the exact board position the printed rule describes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeContext, type GameContext } from '../../src/core/context.ts';
import { createBattle } from '../../src/core/init.ts';
import { reduce } from '../../src/core/reducer.ts';
import { ScriptedRng, SeededRng } from '../../src/core/rng.ts';
import type { GameState, KillzoneMap, PlayerId, Vec2 } from '../../src/core/types.ts';
import { defaultRoster, type RosterPickIn } from '../../src/teams/selection.ts';
import { applyLoadouts, validateRosterFor } from '../../src/teams/selection.ts';
import type { KtTeamModule } from '../../src/teams/helpers.ts';
import { testMap } from '../fixtures.ts';

const MAPS_ROOT = join(process.cwd(), 'data/maps');

/** Every extracted Approved Ops map, sorted by id (so map choice is deterministic). */
export function realMaps(): KillzoneMap[] {
  const out: KillzoneMap[] = [];
  for (const killzone of readdirSync(MAPS_ROOT).sort()) {
    const dir = join(MAPS_ROOT, killzone);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const map = JSON.parse(readFileSync(join(dir, file), 'utf8')) as KillzoneMap;
      if (map?.id) out.push(map);
    }
  }
  return out;
}

export function mapById(id: string): KillzoneMap {
  const found = realMaps().find((m) => m.id === id);
  if (!found) throw new Error(`No map '${id}' in data/maps`);
  return found;
}

/** A context that knows about these team modules (datacards, module, faction equipment). */
export function teamContext(modules: KtTeamModule[], opts: { seed?: number; script?: number[] } = {}): GameContext {
  const ctx = makeContext({ rng: opts.script ? new ScriptedRng(opts.script) : new SeededRng(opts.seed ?? 11) });
  for (const mod of modules) {
    ctx.teams.set(mod.id, mod);
    for (const card of mod.datacards) ctx.datacards.set(card.id, card);
    for (const eq of mod.equipmentDefs) ctx.equipment.set(eq.id, eq);
  }
  const map = testMap();
  ctx.maps.set(map.id, map);
  return ctx;
}

export interface SideSpec {
  module: KtTeamModule;
  picks?: RosterPickIn[];
  equipment?: string[];
  /** Where to deploy each operative, in pick order. */
  positions?: Vec2[];
}

export interface BattleSpec {
  ctx: GameContext;
  map?: KillzoneMap;
  p1: SideSpec;
  p2: SideSpec;
  seed?: number;
}

/**
 * Roster → deployed → firefight phase, with every operative ready. Deployment is done through
 * the reducer where the drop zone allows it and by direct placement otherwise, so a rule test
 * can put operatives exactly where the printed rule's distances need them.
 */
export function battle(spec: BattleSpec): GameState {
  const ctx = spec.ctx;
  const map = spec.map ?? testMap();
  let state = createBattle(ctx, { map, seed: spec.seed ?? 11 });
  state.setup.dropZone = { p1: 'p1', p2: 'p2' };

  for (const player of ['p1', 'p2'] as PlayerId[]) {
    const side = player === 'p1' ? spec.p1 : spec.p2;
    const picks = side.picks ?? defaultRoster(side.module.data);
    const validation = validateRosterFor(side.module.data, picks);
    state = reduce(
      state,
      { t: 'SelectRoster', player, teamId: side.module.id, operatives: picks.map((p) => ({ datacardId: p.datacardId })) },
      ctx,
    ).state;
    applyLoadouts(state, state.teams[player].operativeIds, validation.weapons);
    if (side.equipment && side.equipment.length > 0) {
      state = reduce(state, { t: 'SelectEquipment', player, equipment: side.equipment }, ctx).state;
    }
  }

  // Place operatives: a tidy column in each half, or the caller's own positions.
  for (const player of ['p1', 'p2'] as PlayerId[]) {
    const side = player === 'p1' ? spec.p1 : spec.p2;
    const ids = state.teams[player].operativeIds;
    ids.forEach((id, i) => {
      const op = state.operatives[id]!;
      const fallback: Vec2 = { x: player === 'p1' ? 3 : 27, y: 2 + (i % 9) * 2.2 };
      op.pos = side.positions?.[i] ?? fallback;
      op.z = 0;
      op.order = 'engage';
      op.ready = true;
    });
  }
  state.setup.step = 'done';
  state.phase = 'firefight';
  state.firefightStep = 'performActions';
  state.turningPoint = 1;
  state.initiative = 'p1';
  state.activePlayer = 'p1';
  return state;
}

/** Resolve every pending decision with the deterministic default policy. */
export function settle(ctx: GameContext, state: GameState, choose?: (kind: string) => string | undefined): GameState {
  let s = state;
  let guard = 0;
  while (s.pending.length > 0 && guard++ < 60) {
    const d = s.pending[0]!;
    const override = choose?.(d.kind);
    const optionId = override ?? defaultOption(d.kind, d.options.map((o) => o.id));
    const picked = d.options.find((o) => o.id === optionId) ?? d.options.find((o) => !o.disabled);
    s = reduce(
      s,
      {
        t: 'ResolveDecision',
        decisionId: d.id,
        optionId: picked?.id ?? 'keep',
        ...(picked?.data ? { data: picked.data } : {}),
      },
      ctx,
    ).state;
  }
  return s;
}

function defaultOption(kind: string, ids: string[]): string {
  if (kind === 'reroll') return ids.find((i) => i === 'keep') ?? ids[0]!;
  if (kind === 'retention') return ids[0]!;
  if (kind === 'allocateDefence') return 'auto';
  if (kind === 'coverOrObscured') return 'obscured';
  return ids[0]!;
}

/** Convenience: activate an operative and perform one action. */
export function act(
  ctx: GameContext,
  state: GameState,
  operativeId: string,
  action: string,
  params: Record<string, unknown> = {},
): { state: GameState; ok: boolean; reason?: string } {
  const out = reduce(state, { t: 'PerformAction', operativeId, action, params }, ctx);
  return { state: out.state, ok: out.ok, ...(out.reason ? { reason: out.reason } : {}) };
}

export function activate(ctx: GameContext, state: GameState, operativeId: string, order: 'engage' | 'conceal' = 'engage'): GameState {
  const op = state.operatives[operativeId]!;
  return reduce(state, { t: 'ActivateOperative', player: op.player, operativeId, order }, ctx).state;
}

/** Operative id of the first operative with this datacard on a side. */
export function opWith(state: GameState, player: PlayerId, datacardId: string): string {
  const id = state.teams[player].operativeIds.find((x) => state.operatives[x]!.datacardId === datacardId);
  if (!id) throw new Error(`No '${datacardId}' in ${player}'s kill team`);
  return id;
}
