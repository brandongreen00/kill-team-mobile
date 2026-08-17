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
import {
  requisitionGroups,
  selectionEntries,
  type OptionGroup,
  type SelectionConstraint,
  type SelectionEntry,
  type TeamData,
} from './data.ts';

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
  /** Machine-readable code per error, in the same order (see `ERROR_CODES`). */
  codes: string[];
  /** Resolved weapon names per pick, in pick order (selection + always-available weapons). */
  weapons: string[][];
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Stable id per selection row: several rows can share a datacard (Kasrkin GUNNER ×5).
 * Memoised per team object — looking one up used to rebuild the whole entry list.
 */
const ID_CACHE = new WeakMap<TeamData, string[]>();

function entryIds(data: TeamData): string[] {
  const hit = ID_CACHE.get(data);
  if (hit) return hit;
  const out = selectionEntries(data).map(
    (entry, index) => `${data.id}.sel${index}.${norm(entry.role).replace(/[^a-z0-9]+/g, '-')}`,
  );
  ID_CACHE.set(data, out);
  return out;
}

export function entryId(data: TeamData, index: number): string {
  return entryIds(data)[index] ?? `${data.id}.sel${index}.unknown`;
}

export function entryById(data: TeamData, id: string): SelectionEntry | undefined {
  const idx = entryIds(data).indexOf(id);
  return idx < 0 ? undefined : selectionEntries(data)[idx];
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

// ---------------------------------------------------------------------------
// "…Or one option from each of the following" — an XOR between two whole modes
// ---------------------------------------------------------------------------

/** Which half of an `either` entry a pick has taken. */
export type LoadoutMode = 'options' | 'each';

/**
 * An entry printed as *"…with one of the following options: A; B"* **followed by** *"Or one
 * option from each of the following: (C or D) + (E or F)"*. The word is **or**: one whole
 * mode is taken, never a choice from each side.
 */
export function isEitherEntry(entry: SelectionEntry): boolean {
  return (
    entry.loadoutMode === 'either' &&
    entry.loadouts.length > 0 &&
    entry.optionGroups.length + entry.fixedChoiceGroups.length > 0
  );
}

/** The option groups of an `either` entry's "one option from each of the following" half. */
export function eachGroups(entry: SelectionEntry): OptionGroup[] {
  return [...entry.optionGroups, ...entry.fixedChoiceGroups];
}

/** The mode this pick has committed to, or null while nothing in either half is chosen. */
export function modeOfPick(entry: SelectionEntry, pick: RosterPickIn): LoadoutMode | null {
  const chosen = new Set([...(pick.loadoutIds ?? []), ...(pick.loadoutId ? [pick.loadoutId] : [])]);
  if (entry.loadouts.some((l) => chosen.has(l.id))) return 'options';
  if (eachGroups(entry).some((g) => g.choices.some((c) => chosen.has(c.id)))) return 'each';
  return null;
}

const EITHER_PROMPT = (entry: SelectionEntry): string =>
  `choose one of ${entry.loadouts.map((l) => l.label).join(' / ')}, or one option from each of ${eachGroups(entry)
    .map((g) => g.label)
    .join(' + ')}`;

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
/** Error codes that only mean "the roster is not finished yet". */
export const COUNT_CODES = ['leaderCount', 'slotCount', 'groupCount', 'totalCount'];

/**
 * Selections used per printed group.
 *
 * A group printed as *"N operatives selected from **the list above**"* offers the entries of
 * the group it draws from, so those picks fill the source group first and then spill into it —
 * otherwise the source group reads as over-full while the later group reads as empty and no
 * roster can satisfy both.
 */
export function groupUsage(data: TeamData, entries: SelectionEntry[]): Map<number, number> {
  const used = new Map<number, number>();
  for (const g of data.selection.groups ?? []) used.set(g.index, 0);
  for (const e of entries) used.set(e.group, (used.get(e.group) ?? 0) + e.selectionCost);
  for (const g of data.selection.groups ?? []) {
    if (g.drawsFrom === undefined) continue;
    const src = (data.selection.groups ?? []).find((x) => x.index === g.drawsFrom);
    if (!src) continue;
    const over = (used.get(src.index) ?? 0) - src.count;
    if (over > 0) {
      used.set(src.index, src.count);
      used.set(g.index, (used.get(g.index) ?? 0) + over);
    }
  }
  return used;
}

/**
 * Merge the datacards a REQUISITIONED group borrows from another kill team, applying the
 * printed keyword swap ("These operatives have their faction keyword replaced in all
 * instances on their datacards with INQUISITORIAL AGENT").
 *
 * Only datacards move: the selection entries already reference them by id, so entry ids —
 * and therefore saved rosters — are identical with and without the donors.
 */
export function withRequisitioned(data: TeamData, donors: TeamData[]): TeamData {
  const block = data.selection.requisition;
  if (!block) return data;
  const byId = new Map(donors.map((d) => [d.id, d]));
  const swap = block.factionKeyword;
  const extra: Datacard[] = [];
  const have = new Set(data.datacards.map((c) => c.id));
  for (const g of block.groups) {
    const donor = g.sourceTeam ? byId.get(g.sourceTeam) : undefined;
    if (!donor) continue;
    for (const id of new Set(g.entries.map((e) => e.datacardId))) {
      if (have.has(id)) continue;
      const card = donor.datacards.find((c) => c.id === id);
      if (!card) continue;
      have.add(id);
      extra.push(
        swap
          ? { ...card, keywords: card.keywords.map((k) => (k.toUpperCase() === g.keyword.toUpperCase() ? swap : k)) }
          : card,
      );
    }
  }
  return extra.length === 0 ? data : { ...data, datacards: [...data.datacards, ...extra] };
}

export function validateRosterFor(data: TeamData, picks: RosterPickIn[]): RosterValidation {
  const errors: string[] = [];
  const codes: string[] = [];
  const fail = (code: string, message: string): void => {
    codes.push(code);
    errors.push(message);
  };
  const sel = data.selection;
  const resolved: { entry: SelectionEntry; index: number; pick: RosterPickIn; weapons: string[] }[] = [];
  const weapons: string[][] = [];

  for (const pick of picks) {
    const r = resolveEntry(data, pick);
    if (!r) {
      fail('unknownEntry', `'${pick.datacardId}' is not on the ${data.name} selection list`);
      weapons.push([]);
      continue;
    }
    const w = weaponsForPick(data, r.entry, pick);
    resolved.push({ ...r, pick, weapons: w });
    weapons.push(w);
  }

  // ---- total kill team size ------------------------------------------------
  const total = resolved.reduce((n, r) => n + r.entry.selectionCost, 0);
  const leaderPicks = resolved.filter((r) => r.entry.isLeader);
  const nonLeader = resolved.filter((r) => !r.entry.isLeader);
  const leaderCount = sel.leader?.count ?? 1;
  if (leaderPicks.length !== leaderCount) {
    fail(
      'leaderCount',
      `a ${data.name} kill team must include exactly ${leaderCount} ${sel.leader?.role ?? 'LEADER'} operative (found ${leaderPicks.length})`,
    );
  }
  const slots = sel.slots;
  // Some kill teams print their leader as one entry of the same list the other operatives
  // come from — "5 DEATHWATCH operatives selected from the following list: WATCH SERGEANT,
  // AEGIS, ..." — so the leader consumes one of the N rather than sitting on top of it.
  // Counting it as extra made those teams impossible to field: leader + N breaks the total,
  // and leader + (N-1) breaks the slot count.
  const leaderInList = sel.leader?.inList === true;
  const counted = leaderInList ? resolved : nonLeader;
  const used = counted.reduce((n, r) => n + r.entry.selectionCost, 0);
  if (used !== slots) {
    fail(
      'slotCount',
      leaderInList
        ? `select exactly ${slots} operatives in total, including the ${sel.leader?.role ?? 'leader'} (${used} selected)`
        : `select exactly ${slots} further operatives (${used} selected)`,
    );
  }
  if (sel.totalOperatives && total > sel.totalOperatives) {
    fail('totalCount', `a ${data.name} kill team is ${sel.totalOperatives} operatives at most`);
  }

  // ---- the datacard has to be here -----------------------------------------
  // A REQUISITIONED entry's datacard is printed on the donor kill team's page; until that
  // team's JSON is merged in (`withRequisitioned`) the operative cannot be fielded. Say so
  // rather than handing out an operative with no stats or weapons.
  for (const r of resolved) {
    if (data.datacards.some((c) => c.id === r.entry.datacardId)) continue;
    const from = requisitionGroups(data).find((g) => g.id === r.entry.requisitionGroup);
    fail(
      'unavailableDatacard',
      from?.sourceTeam
        ? `${r.entry.role}: its datacard is printed with the ${from.name} kill team and is not loaded here`
        : `${r.entry.role}: no datacard '${r.entry.datacardId}' in ${data.name}`,
    );
  }

  // ---- per-group counts ("1 PLASMACYTE REANIMATOR operative") ---------------
  const groupUsed = groupUsage(data, resolved.map((r) => r.entry));
  for (const group of sel.groups ?? []) {
    const cost = groupUsed.get(group.index) ?? 0;
    if (cost !== group.count) {
      fail('groupCount', `${group.rawText.trim()} — ${cost} selected`);
    }
  }

  // ---- uniqueness ----------------------------------------------------------
  const uniqueExcept = new Set<string>();
  let relaxed: { alternative: string; role: string; max: number; distinctOptions: boolean; text: string } | null = null;
  for (const c of sel.constraints) {
    if (c.kind === 'uniqueExcept') for (const role of (c as { roles: string[] }).roles) uniqueExcept.add(norm(role));
    if (c.kind === 'uniqueUnlessAlternative')
      relaxed = c as unknown as { alternative: string; role: string; max: number; distinctOptions: boolean; text: string };
  }
  /** Are any operatives from the alternative (REQUISITIONED) source in the kill team? */
  const usingAlternative = resolved.some((r) => Boolean(r.entry.requisitionGroup));
  const byIndex = new Map<number, number>();
  for (const r of resolved) byIndex.set(r.index, (byIndex.get(r.index) ?? 0) + 1);
  for (const [index, n] of byIndex) {
    const entry = selectionEntries(data)[index]!;
    if (n <= 1) continue;
    const exempt = uniqueExcept.has(norm(entry.role)) || !entry.uniqueUnlessRole;
    if (exempt) continue;
    if (relaxed && !usingAlternative && norm(entry.role) === norm(relaxed.role)) {
      if (n > relaxed.max) fail('unique', `${relaxed.text} — ${entry.role} selected ${n} times`);
      continue;
    }
    fail('unique', `your kill team can only include each operative on this list once — ${entry.role} selected ${n} times`);
  }
  // "…but each one must have different options."
  if (relaxed?.distinctOptions && !usingAlternative) {
    const same = resolved.filter((r) => norm(r.entry.role) === norm(relaxed!.role));
    const seen = new Set(same.map((r) => r.weapons.map(norm).sort().join('|')));
    if (same.length > 1 && seen.size < same.length)
      fail('unique', `${relaxed.text} — two ${relaxed.role} operatives have the same option`);
  }

  // ---- printed constraints -------------------------------------------------
  type Scope = typeof resolved;
  const checkPrinted = (list: SelectionConstraint[], scope: Scope, footnotes: Record<string, string>): void => {
    const countRole = (role: string): number => scope.filter((r) => norm(r.entry.role) === norm(role)).length;
    /**
     * "…up to one COMBAT SERVITOR operative **with meltagun**…" — the printed maximum counts
     * only the operatives of that role whose resolved weapons include that weapon, so the
     * same role can appear more often with a different option.
     */
    const countRoleWithWeapon = (role: string, weapon: string): number =>
      scope.filter((r) => norm(r.entry.role) === norm(role) && r.weapons.some((w) => norm(w) === norm(weapon))).length;
    for (const c of list) {
      if (c.kind === 'maxCount') {
        const cc = c as { role: string; max: number };
        if (countRole(cc.role) > cc.max)
          fail('maxCount', `you cannot select more than ${cc.max} ${cc.role} operatives (${countRole(cc.role)} selected)`);
      } else if (c.kind === 'maxCountWithWeapon') {
        const cc = c as { role: string; weapon: string; max: number; text?: string };
        const n = countRoleWithWeapon(cc.role, cc.weapon);
        if (n > cc.max)
          fail(
            'maxCountWithWeapon',
            `${cc.text ?? `your kill team can only include up to ${cc.max} ${cc.role} operatives with ${cc.weapon}`} — ${n} ${cc.role} operatives with ${cc.weapon} selected`,
          );
      } else if (c.kind === 'requires') {
        const cc = c as { role: string; requiresRole: string };
        if (countRole(cc.role) > 0 && countRole(cc.requiresRole) === 0)
          fail('requires', `you can only select a ${cc.role} operative if your kill team includes a ${cc.requiresRole} operative`);
      } else if (c.kind === 'groupCap') {
        const cc = c as { group: string; max: number };
        const n = scope.filter((r) => r.entry.footnoteGroup === cc.group).length;
        if (n > cc.max)
          fail('groupCap', `${footnotes[cc.group] ?? `at most ${cc.max} of these operatives combined`} (${n} selected)`);
      } else if (c.kind === 'halfSelection') {
        const cc = c as { group: string; max: number };
        const cost = scope.filter((r) => r.entry.footnoteGroup === cc.group).reduce((n, r) => n + r.entry.selectionCost, 0);
        if (cost > cc.max)
          fail('halfSelection', `${footnotes[cc.group] ?? 'these operatives count as half a selection each'} (${cost} selections used)`);
      } else if (c.kind === 'oneRequisitionGroup') {
        const cc = c as { keyword: string; text: string };
        const taken = [...new Set(scope.map((r) => r.entry.requisitionGroup).filter(Boolean))] as string[];
        if (taken.length > 1) {
          const names = taken.map((id) => requisitionGroups(data).find((g) => g.id === id)?.name ?? id);
          fail('oneRequisitionGroup', `${cc.text} — ${cc.keyword} operatives taken from ${names.join(' and ')}`);
        }
      }
    }
  };
  checkPrinted(sel.constraints, resolved, sel.footnotes);
  // Each REQUISITIONED group prints its own list rules ("Other than TROOPER operatives…",
  // "You cannot select more than two of these operatives combined"), scoped to that group.
  for (const g of requisitionGroups(data)) {
    const scope = resolved.filter((r) => r.entry.requisitionGroup === g.id);
    if (scope.length > 0) checkPrinted(g.constraints, scope, g.footnotes);
  }

  // ---- loadout choices -----------------------------------------------------
  for (const { entry, pick } of resolved) {
    const groups = [...entry.optionGroups, ...entry.fixedChoiceGroups];
    const chosen = new Set([...(pick.loadoutIds ?? []), ...(pick.loadoutId ? [pick.loadoutId] : [])]);
    const named = new Set((pick.weapons ?? []).map(norm));
    // "…with one of the following options: A; B. **Or** one option from each of the
    // following: (C or D) + (E or F)" — the two halves are alternatives, not additions.
    // Exactly one of them is taken; taking a choice in both is an illegal loadout.
    if (isEitherEntry(entry)) {
      const byOption = entry.loadouts.some((l) => chosen.has(l.id));
      const byEach = groups.filter((g) => g.choices.some((c) => chosen.has(c.id))).length;
      if (byOption && byEach > 0) {
        fail('loadout', `${entry.role}: ${EITHER_PROMPT(entry)} — choose one of the two, not both`);
      } else if (!byOption && byEach !== groups.length) {
        const namedOption =
          entry.loadouts.some((l) => l.weapons.length > 0 && l.weapons.every((w) => named.has(norm(w)))) ||
          groups.every((g) => g.choices.some((c) => c.weapons.length > 0 && c.weapons.every((w) => named.has(norm(w)))));
        if (!namedOption) fail('loadout', `${entry.role}: ${EITHER_PROMPT(entry)}`);
      }
      continue;
    }
    if (entry.loadouts.length > 0) {
      const has =
        entry.loadouts.some((l) => chosen.has(l.id)) ||
        entry.loadouts.some((l) => l.weapons.every((w) => named.has(norm(w))));
      if (!has) fail('loadout', `${entry.role}: choose one of ${entry.loadouts.map((l) => l.label).join(' / ')}`);
    }
    for (const g of groups) {
      const has =
        g.choices.some((c) => chosen.has(c.id)) || g.choices.some((c) => c.weapons.every((w) => named.has(norm(w))));
      if (!has) fail('loadout', `${entry.role}: choose ${g.label}`);
    }
  }

  return { ok: errors.length === 0, errors, codes, weapons };
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

/**
 * A legal roster built deterministically from the printed selection list: the leader first,
 * then list entries in printed order, skipping any pick that would break a constraint.
 * Used by the tests, the soak driver and as the app's "quick start" roster.
 */
export function defaultRoster(data: TeamData): RosterPickIn[] {
  const entries = selectionEntries(data);
  const picks: RosterPickIn[] = [];
  const pickOf = (entry: SelectionEntry, index: number): RosterPickIn => ({
    datacardId: entry.datacardId,
    entryId: entryId(data, index),
    // An `either` entry is an XOR: take the printed options list, never both halves.
    loadoutIds: isEitherEntry(entry)
      ? [entry.loadouts[0]!.id]
      : [
          ...(entry.loadouts[0] ? [entry.loadouts[0].id] : []),
          ...entry.optionGroups.map((g) => g.choices[0]?.id).filter((x): x is string => Boolean(x)),
          ...entry.fixedChoiceGroups.map((g) => g.choices[0]?.id).filter((x): x is string => Boolean(x)),
        ],
  });

  // Leader group(s) first — every group whose entries are marked isLeader.
  entries.forEach((entry, index) => {
    if (!entry.isLeader) return;
    if (picks.some((p) => resolveEntry(data, p)?.entry.isLeader)) return;
    picks.push(pickOf(entry, index));
  });

  /**
   * The picks to try for one entry, best first. A second copy of an entry whose options must
   * differ ("…but each one must have different options") only fits on its other option, so
   * every printed option is offered rather than just the first.
   */
  const variantsOf = (entry: SelectionEntry, index: number): RosterPickIn[] => {
    const first = pickOf(entry, index);
    if (isEitherEntry(entry) || entry.loadouts.length < 2) return [first];
    return entry.loadouts.map((l) => ({
      ...first,
      loadoutIds: [l.id, ...(first.loadoutIds ?? []).filter((id) => !entry.loadouts.some((x) => x.id === id))],
    }));
  };

  // Then fill each remaining group to its printed count, in list order.
  for (const group of data.selection.groups ?? []) {
    // Do NOT skip a group just because the leader belongs to it. When the leader is drawn
    // from the same list ("5 DEATHWATCH operatives selected from the following list: WATCH
    // SERGEANT, ..."), skipping left the roster with nothing but the leader. The leader's
    // pick is already counted in `filled` below, so a group of exactly one leader fills
    // itself and needs no special case.
    // A group printed as "selected from the list above" offers the source group's entries
    // too, and its own (REQUISITIONED) entries after them, in printed order.
    const offers = (entry: SelectionEntry): boolean =>
      entry.group === group.index || (group.drawsFrom !== undefined && entry.group === group.drawsFrom);
    let guard = 0;
    while ((groupUsage(data, resolvedEntries(data, picks)).get(group.index) ?? 0) < group.count && guard++ < 200) {
      let added = false;
      for (let index = 0; index < entries.length && !added; index++) {
        const entry = entries[index]!;
        if (!offers(entry) || entry.isLeader) continue;
        for (const variant of variantsOf(entry, index)) {
          const trial = [...picks, variant];
          if ((groupUsage(data, resolvedEntries(data, trial)).get(group.index) ?? 0) > group.count) continue;
          const check = validateRosterFor(data, trial);
          if (check.codes.some((c) => !COUNT_CODES.includes(c))) continue;
          picks.push(variant);
          added = true;
          break;
        }
      }
      if (!added) break;
    }
  }
  return picks;
}

/** The selection entries a set of picks resolves to, dropping any that do not resolve. */
function resolvedEntries(data: TeamData, picks: RosterPickIn[]): SelectionEntry[] {
  return picks.map((p) => resolveEntry(data, p)?.entry).filter((e): e is SelectionEntry => Boolean(e));
}
