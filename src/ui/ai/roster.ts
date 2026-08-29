/**
 * What the AI brings to the battle: a kill team, its equipment, and a tac op.
 *
 * None of this is new rules code. `defaultRoster` (`src/teams/selection.ts`) already builds a
 * legal roster from any team's printed selection list — it is what the tests and the soak
 * driver field — and `validateRosterFor` is the same validator the roster builder screen runs
 * against a human's picks. This module only chooses *which* team, and packages the result into
 * the exact `SelectRoster` shape the reducer wants.
 *
 * The one thing that is easy to get wrong and impossible to see afterwards is `applyLoadouts`.
 * The reducer stores neither `loadoutId` nor `weapons` (it builds an operative from the
 * datacard alone), and `weaponsOf` falls back to the *whole* datacard when nothing is recorded
 * in `opState.loadout` — so an AI roster dispatched without it fields operatives carrying every
 * weapon printed on their card at once, with no rejection and nothing in the log. The human
 * path calls it in `App.tsx`; `aiSelectRoster` below is the AI's copy of that same call.
 */
import type { GameContext } from '../../core/context.ts';
import { equipmentItems } from '../../core/equipment/index.ts';
import { availableOps } from '../../core/game.ts';
import type { GameState, PlayerId } from '../../core/types.ts';
import { applyLoadouts, defaultRoster, validateRosterFor } from '../../teams/selection.ts';
import type { TeamData as SelectionTeamData } from '../../teams/data.ts';
import type { Store } from '../store.ts';
import type { TeamData } from '../data.ts';
import { asTeamData } from '../roster/rules.ts';

/**
 * The AI never puts anything on the player's undo stack. "Undo last placement" is there so a
 * person can take back their own misplaced operative; offering it for the opponent's is both
 * meaningless and, since every snapshot is a deep copy of the whole GameState, expensive.
 */
export const AI_DISPATCH = { undoable: false } as const;

/**
 * A deterministic index from a battle seed.
 *
 * `Math.random` is banned outside `src/core/rng.ts` (CLAUDE.md rule #2, `pnpm lint:rng`), and
 * forking `ctx.rng` here would tie the AI's kill team to the position of the match dice stream
 * rather than to the battle. Knuth's multiplicative hash keeps consecutive seeds from picking
 * adjacent entries, so "new battle" (which is `seed + 1`) does not walk the list alphabetically.
 */
export function seededIndex(seed: number, salt: number, length: number): number {
  if (length <= 0) return 0;
  const mixed = (Math.imul(seed + salt, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
  return mixed % length;
}

/**
 * Teams the AI can actually field: a printed selection block, and a `defaultRoster` that
 * validates against it.
 *
 * Memoised on the team list's identity because the answer costs 48 roster builds — ~150ms —
 * and the opponent picker asks for it on every render, i.e. on every tap of every row.
 */
const PLAYABLE = new WeakMap<TeamData[], TeamData[]>();
export function playableTeams(teams: TeamData[]): TeamData[] {
  const hit = PLAYABLE.get(teams);
  if (hit) return hit;
  const out = teams.filter((t) => asTeamData(t) !== null && defaultRosterOf(t) !== null);
  PLAYABLE.set(teams, out);
  return out;
}

/** `defaultRoster` for a UI team, or null when the team cannot legally be built. */
export function defaultRosterOf(team: TeamData): { data: SelectionTeamData; picks: ReturnType<typeof defaultRoster>; weapons: string[][] } | null {
  const data = asTeamData(team);
  if (!data) return null;
  const picks = defaultRoster(data);
  if (picks.length === 0) return null;
  const check = validateRosterFor(data, picks);
  return check.ok ? { data, picks, weapons: check.weapons } : null;
}

/** Which kill team the AI fields when nobody has chosen one for it. */
export function chooseAiTeamId(teams: TeamData[], seed: number): string | undefined {
  const playable = playableTeams(teams);
  if (playable.length === 0) return undefined;
  return playable[seededIndex(seed, 17, playable.length)]?.id;
}

/**
 * Select the AI's kill team, exactly as the roster builder does for a human.
 *
 * Returns false without dispatching when the team cannot be built, rather than sending a
 * roster the reducer will refuse: `SelectRoster` writes each operative into `state.operatives`
 * *before* it checks the next pick's datacard, so a refusal partway through leaves undeployed
 * records behind that `FinishSetup` then counts forever, and the battle can never start.
 */
export function aiSelectRoster(store: Store, teams: TeamData[], player: PlayerId, teamId: string): boolean {
  const team = teams.find((t) => t.id === teamId);
  const built = team ? defaultRosterOf(team) : null;
  if (!built) return false;
  // Every datacard must already be registered, for the same reason.
  if (built.picks.some((p) => !store.ctx.datacards.has(p.datacardId))) return false;

  const ok = store.dispatch(
    {
      t: 'SelectRoster',
      player,
      teamId: built.data.id,
      operatives: built.picks.map((p, i) => ({
        datacardId: p.datacardId,
        ...(p.loadoutIds?.[0] ? { loadoutId: p.loadoutIds[0] } : p.loadoutId ? { loadoutId: p.loadoutId } : {}),
        weapons: built.weapons[i] ?? [],
      })),
    },
    AI_DISPATCH,
  );
  if (!ok) return false;
  applyLoadouts(store.state, store.state.teams[player].operativeIds, built.weapons);
  return true;
}

/**
 * The equipment the AI takes: universal options that need no set-up on the killzone.
 *
 * Two limits, both real. `ctx.equipment` carries only the eleven universal options — faction
 * equipment is not registered there, which is why the human's faction list is empty too — so
 * anything else would be rejected as `unknown equipment`. And an option with `items` (a
 * barricade, a ladder, mines) has to be *placed* during the SET UP EQUIPMENT step, which needs
 * a placement planner the AI package does not have; taking one and then skipping the placement
 * would spend a choice on nothing. So the AI takes what it can use without placing: grenades
 * and the breaching charge.
 */
export function aiEquipmentIds(ctx: GameContext, seed: number): string[] {
  const usable = [...ctx.equipment.keys()].filter((id) => equipmentItems(id).length === 0).sort();
  if (usable.length === 0) return [];
  // Rotate the list by the seed so two battles do not always open with the same four.
  const start = seededIndex(seed, 29, usable.length);
  const rotated = [...usable.slice(start), ...usable.slice(0, start)];
  return rotated.slice(0, 4);
}

/**
 * The AI's tac op. Chosen from the printed twelve rather than from a short-list, because a
 * fixed favourite would make every solo game score the same way; the AI plays them generically
 * (docs/AI.md §8) so none of them is a bad choice for a different reason.
 */
export function aiTacOpId(state: GameState, player: PlayerId, seed: number): string | undefined {
  const archetypes = state.teams[player].archetypes;
  const tacOps = availableOps().filter(
    (o) => o.kind === 'tac' && (!o.archetype || archetypes.length === 0 || archetypes.includes(o.archetype)),
  );
  if (tacOps.length === 0) return undefined;
  return tacOps[seededIndex(seed, player === 'p1' ? 3 : 11, tacOps.length)]?.id;
}
