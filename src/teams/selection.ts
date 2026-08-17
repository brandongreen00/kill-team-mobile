/**
 * Kill-team selection rules, driven entirely by the `selection` block of
 * `data/teams/<slug>.json` — there is no per-team selection code.
 *
 * Core rules › Select Operatives: "Select operatives for your kill team as specified by its
 * selection requirements." The normalised block gives us, per team: the leader group, how
 * many selections each group allows, each list entry's selection cost, and the constraints
 * printed underneath the list ("Other than TROOPER operatives, your kill team can only
 * include each operative on this list once", "You cannot select more than four of these
 * operatives combined", "These operatives count as half a selection each…").
 *
 * WEAPONS. Where an entry says "with one of the following options" the operative gets
 * exactly that option's weapons. **Every weapon on its datacard that no selection option for
 * that datacard names is always available to it, including `Limited x` weapons** — e.g. the
 * Navis Grenadier keeps its demolition charge, both Navis shotgun profiles and the Navis
 * hatchet without choosing anything.
 */
import type { Datacard, GameState } from '../core/types.ts';
import { selectionEntries, type SelectionEntry, type TeamData } from './data.ts';

export interface RosterPickIn {
  datacardId: string;
  /** Explicit selection-entry id (from `entryId`), when the same datacard has several rows. */
  entryId?: string;
  /** Chosen loadout / option-group choice ids. */
  loadoutId?: string;
  loadoutIds?: string[];
  /** Explicit weapon names, used to disambiguate an entry when no id is given. */
  weapons?: string[];
}

export interface RosterValidation {
  ok: boolean;
  errors: string[];
  /** Resolved weapon names per pick, in pick order (selection + always-available weapons). */
  weapons: string[][];
}

const norm = (s: string): string => s.trim().toLowerCase();

/** Stable id for a selection row: several rows can share a datacard (Kasrkin GUNNER ×5). */
export function entryId(data: TeamData, index: number): string {
  const entry = selectionEntries(data)[index];
  return `${data.id}.sel${index}.${entry ? norm(entry.role).replace(/[^a-z0-9]+/g, '-') : 'unknown'}`;
}

export function entryById(data: TeamData, id: string): SelectionEntry | undefined {
  const entries = selectionEntries(data);
  const idx = entries.findIndex((_, i) => entryId(data, i) === id);
  return idx < 0 ? undefined : entries[idx];
}

/** Every weapon name any selection option for this datacard names. */
export function namedWeapons(data: TeamData, datacardId: string): Set<string> {
  const out = new Set<string>();
  for (const entry of selectionEntries(data)) {
    if (entry.datacardId !== datacardId) continue;
    for (const w of [...entry.fixedWeapons, ...entry.alwaysWeapons]) out.add(norm(w));
    for (const l of entry.loadouts) for (const w of l.weapons) out.add(norm(w));
    for (const g of [...entry.optionGroups, ...entry.fixedChoiceGroups])
      for (const c of g.choices) for (const w of c.weapons) out.add(norm(w));
  }
  return out;
}

/**
 * Weapons that are always on the operative's card regardless of what the selection list
 * says — "every datacard weapon not named in any selection option is always available".
 */
export function alwaysAvailableWeapons(data: TeamData, card: Datacard): string[] {
  const named = namedWeapons(data, card.id);
  return card.weapons.filter((w) => !named.has(norm(w.name))).map((w) => w.name);
}

/** The weapons one pick ends up with: chosen option + fixed/always + always-available. */
export function weaponsForPick(data: TeamData, entry: SelectionEntry, pick: RosterPickIn): string[] {
  const card = data.datacards.find((c) => c.id === entry.datacardId);
  const chosenIds = new Set([...(pick.loadoutIds ?? []), ...(pick.loadoutId ? [pick.loadoutId] : [])]);
  const picked = new Set<string>();
  for (const w of [...entry.fixedWeapons, ...entry.alwaysWeapons]) picked.add(norm(w));
  for (const l of entry.loadouts) if (chosenIds.has(l.id)) for (const w of l.weapons) picked.add(norm(w));
  for (const g of [...entry.optionGroups, ...entry.fixedChoiceGroups])
    for (const c of g.choices) if (chosenIds.has(c.id)) for (const w of c.weapons) picked.add(norm(w));
  // Explicit weapon names (used by the importer / AI) count as choices too.
  for (const w of pick.weapons ?? []) picked.add(norm(w));
  const always = card ? alwaysAvailableWeapons(data, card) : [];
  for (const w of always) picked.add(norm(w));
  // Return the card's own spelling, in card order, so weapon lookups match by name.
  if (!card) return [...picked];
  return card.weapons.filter((w) => picked.has(norm(w.name))).map((w) => w.name);
}

/** Does this pick plausibly refer to this entry? Used when no explicit entryId is given. */
function matchesEntry(entry: SelectionEntry, pick: RosterPickIn): boolean {
  if (entry.datacardId !== pick.datacardId) return false;
  if (entry.fixedWeapons.length > 0 && pick.weapons) {
    return entry.fixedWeapons.every((w) => pick.weapons!.some((p) => norm(p) === norm(w)));
  }
  const ids = new Set([...(pick.loadoutIds ?? []), ...(pick.loadoutId ? [pick.loadoutId] : [])]);
  if (ids.size > 0) {
    const owns =
      entry.loadouts.some((l) => ids.has(l.id)) ||
      [...entry.optionGroups, ...entry.fixedChoiceGroups].some((g) => g.choices.some((c) => ids.has(c.id)));
    if (owns) return true;
  }
  return true;
}

export function resolveEntry(data: TeamData, pick: RosterPickIn): { entry: SelectionEntry; index: number } | null {
  const entries = selectionEntries(data);
  if (pick.entryId) {
    const idx = entries.findIndex((_, i) => entryId(data, i) === pick.entryId);
    if (idx >= 0) return { entry: entries[idx]!, index: idx };
    return null;
  }
  const candidates = entries.map((entry, index) => ({ entry, index })).filter((c) => matchesEntry(c.entry, pick));
  // Prefer a row whose fixed weapons the pick actually names (Kasrkin GUNNER rows).
  const exact = candidates.find(
    (c) => c.entry.fixedWeapons.length > 0 && pick.weapons && c.entry.fixedWeapons.every((w) => pick.weapons!.some((p) => norm(p) === norm(w))),
  );
  return exact ?? candidates[0] ?? null;
}

/**
 * Validate a roster against the printed selection requirements.
 * Pure: no state, no RNG, no I/O. Errors are player-facing sentences.
 */
export function validateRosterFor(data: TeamData, picks: RosterPickIn[]): RosterValidation {
  const errors: string[] = [];
  const sel = data.selection;
  const resolved: { entry: SelectionEntry; index: number; pick: RosterPickIn }[] = [];
  const weapons: string[][] = [];

  for (const pick of picks) {
    const r = resolveEntry(data, pick);
    if (!r) {
      errors.push(`'${pick.datacardId}' is not on the ${data.name} selection list`);
      weapons.push([]);
      continue;
    }
    resolved.push({ ...r, pick });
    weapons.push(weaponsForPick(data, r.entry, pick));
  }

  // ---- total kill team size ------------------------------------------------
  const total = resolved.reduce((n, r) => n + r.entry.selectionCost, 0);
  const leaderPicks = resolved.filter((r) => r.entry.isLeader);
  const nonLeader = resolved.filter((r) => !r.entry.isLeader);
  const leaderCount = sel.leader?.count ?? 1;
  if (leaderPicks.length !== leaderCount) {
    errors.push(
      `a ${data.name} kill team must include exactly ${leaderCount} ${sel.leader?.role ?? 'LEADER'} operative (found ${leaderPicks.length})`,
    );
  }
  const slots = sel.slots;
  const used = nonLeader.reduce((n, r) => n + r.entry.selectionCost, 0);
  if (used !== slots) {
    errors.push(`select exactly ${slots} further operatives (${used} selected)`);
  }
  if (sel.totalOperatives && total > sel.totalOperatives) {
    errors.push(`a ${data.name} kill team is ${sel.totalOperatives} operatives at most`);
  }

  // ---- per-group counts ("1 PLASMACYTE REANIMATOR operative") ---------------
  for (const group of sel.groups ?? []) {
    const inGroup = resolved.filter((r) => r.entry.group === group.index);
    const cost = inGroup.reduce((n, r) => n + r.entry.selectionCost, 0);
    if (cost !== group.count) {
      errors.push(`${group.rawText.trim()} — ${cost} selected`);
    }
  }

  // ---- uniqueness ----------------------------------------------------------
  const uniqueExcept = new Set<string>();
  for (const c of sel.constraints) {
    if (c.kind === 'uniqueExcept') for (const role of (c as { roles: string[] }).roles) uniqueExcept.add(norm(role));
  }
  const byIndex = new Map<number, number>();
  for (const r of resolved) byIndex.set(r.index, (byIndex.get(r.index) ?? 0) + 1);
  for (const [index, n] of byIndex) {
    const entry = selectionEntries(data)[index]!;
    if (n <= 1) continue;
    const exempt = uniqueExcept.has(norm(entry.role)) || !entry.uniqueUnlessRole;
    if (!exempt) {
      errors.push(`your kill team can only include each operative on this list once — ${entry.role} selected ${n} times`);
    }
  }

  // ---- printed constraints -------------------------------------------------
  const countRole = (role: string): number => resolved.filter((r) => norm(r.entry.role) === norm(role)).length;
  for (const c of sel.constraints) {
    if (c.kind === 'maxCount') {
      const cc = c as { role: string; max: number };
      if (countRole(cc.role) > cc.max)
        errors.push(`you cannot select more than ${cc.max} ${cc.role} operatives (${countRole(cc.role)} selected)`);
    } else if (c.kind === 'requires') {
      const cc = c as { role: string; requiresRole: string };
      if (countRole(cc.role) > 0 && countRole(cc.requiresRole) === 0)
        errors.push(`you can only select a ${cc.role} operative if your kill team includes a ${cc.requiresRole} operative`);
    } else if (c.kind === 'groupCap') {
      const cc = c as { group: string; max: number };
      const n = resolved.filter((r) => r.entry.footnoteGroup === cc.group).length;
      if (n > cc.max) errors.push(`${sel.footnotes[cc.group] ?? `at most ${cc.max} of these operatives combined`} (${n} selected)`);
    } else if (c.kind === 'halfSelection') {
      const cc = c as { group: string; max: number };
      const cost = resolved.filter((r) => r.entry.footnoteGroup === cc.group).reduce((n, r) => n + r.entry.selectionCost, 0);
      if (cost > cc.max)
        errors.push(`${sel.footnotes[cc.group] ?? 'these operatives count as half a selection each'} (${cost} selections used)`);
    }
  }

  // ---- loadout choices -----------------------------------------------------
  for (const { entry, pick } of resolved) {
    const groups = [...entry.optionGroups, ...entry.fixedChoiceGroups];
    const chosen = new Set([...(pick.loadoutIds ?? []), ...(pick.loadoutId ? [pick.loadoutId] : [])]);
    const named = new Set((pick.weapons ?? []).map(norm));
    if (entry.loadouts.length > 0) {
      const has =
        entry.loadouts.some((l) => chosen.has(l.id)) ||
        entry.loadouts.some((l) => l.weapons.every((w) => named.has(norm(w))));
      if (!has) errors.push(`${entry.role}: choose one of ${entry.loadouts.map((l) => l.label).join(' / ')}`);
    }
    for (const g of groups) {
      const has =
        g.choices.some((c) => chosen.has(c.id)) || g.choices.some((c) => c.weapons.every((w) => named.has(norm(w))));
      if (!has) errors.push(`${entry.role}: choose ${g.label}`);
    }
  }

  return { ok: errors.length === 0, errors, weapons };
}

/**
 * Record each operative's weapons on the battle state after `SelectRoster`.
 *
 * The reducer's `RosterPick` carries `loadoutId`/`weapons` but does not persist them, so the
 * team modules read the loadout from `state.opState['loadout']` (namespaced scratch space).
 * When no loadout is recorded an operative simply has every weapon on its datacard.
 */
export function applyLoadouts(state: GameState, operativeIds: string[], weapons: string[][]): void {
  const store = (state.opState['loadout'] ?? {}) as Record<string, string[]>;
  operativeIds.forEach((id, i) => {
    const w = weapons[i];
    if (w && w.length > 0) store[id] = w;
  });
  state.opState['loadout'] = store;
}

export function loadoutOf(state: GameState, operativeId: string): string[] | undefined {
  const store = state.opState['loadout'] as Record<string, string[]> | undefined;
  return store?.[operativeId];
}
