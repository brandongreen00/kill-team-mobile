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
  /** Machine-readable code per error, in the same order (see `ERROR_CODES`). */
  codes: string[];
  /** Resolved weapon names per pick, in pick order (selection + always-available weapons). */
  weapons: string[][];
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * The groups a roster must fill, with every `sameAsAbove` group folded into the list group it
 * refers back to (docs/TEAM-DATA.md §5: "`sameAsAbove` (Inquisitorial Agent's second block)").
 */
export function groupTargets(sel: TeamData['selection']): { index: number; count: number; rawText: string; kind: string }[] {
  const out: { index: number; count: number; rawText: string; kind: string }[] = [];
  for (const g of sel.groups ?? []) {
    if (g.kind === 'sameAsAbove' && out.length > 0) {
      const prev = out[out.length - 1]!;
      prev.count += g.count;
      prev.rawText = `${prev.rawText} ${g.rawText.trim()}`;
      continue;
    }
    out.push({ index: g.index, count: g.count, rawText: g.rawText, kind: g.kind });
  }
  return out;
}

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
/** Error codes that only mean "the roster is not finished yet". */
export const COUNT_CODES = ['leaderCount', 'slotCount', 'groupCount', 'totalCount'];

export function validateRosterFor(data: TeamData, picks: RosterPickIn[]): RosterValidation {
  const errors: string[] = [];
  const codes: string[] = [];
  const fail = (code: string, message: string): void => {
    codes.push(code);
    errors.push(message);
  };
  const sel = data.selection;
  const resolved: { entry: SelectionEntry; index: number; pick: RosterPickIn }[] = [];
  const weapons: string[][] = [];

  for (const pick of picks) {
    const r = resolveEntry(data, pick);
    if (!r) {
      fail('unknownEntry', `'${pick.datacardId}' is not on the ${data.name} selection list`);
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

  // ---- per-group counts ("1 PLASMACYTE REANIMATOR operative") ---------------
  // A `sameAsAbove` group draws from the SAME list the preceding group did — "5 INQUISITORIAL
  // AGENT operatives selected from the list above, or REQUISITIONED operatives…". No selection
  // entry is tagged with its index, so it is folded into its source group and the two counts are
  // summed; otherwise it is a group of five that nothing can ever fill.
  for (const group of groupTargets(sel)) {
    const inGroup = resolved.filter((r) => r.entry.group === group.index);
    const cost = inGroup.reduce((n, r) => n + r.entry.selectionCost, 0);
    if (cost !== group.count) {
      fail('groupCount', `${group.rawText.trim()} — ${cost} selected`);
    }
    // "Every ELUCIDIAN STARSTRIDER operative in the following list:" — an `every` group is a
    // FIXED roster, so each printed row must appear exactly its own `count` times. Checking only
    // the group total let `defaultRoster` field ELUCIA VHANE plus nine CANIDs and call it legal.
    if (group.kind !== 'every') continue;
    selectionEntries(data).forEach((entry, index) => {
      // The leader is printed in both `leaderList` and `list`, and a leader pick resolves to the
      // `leaderList` row; its count is already checked by the leader check above.
      if (entry.group !== group.index || entry.isLeader) return;
      const want = entry.count ?? 1;
      const got = resolved.filter((r) => r.index === index).length;
      if (got !== want)
        fail('groupCount', `${group.rawText.trim()} — ${want} ${entry.role}, ${got} selected`);
    });
  }

  // ---- uniqueness ----------------------------------------------------------
  const uniqueExcept = new Set<string>();
  for (const c of sel.constraints) {
    if (c.kind === 'uniqueExcept') for (const role of (c as { roles: string[] }).roles) uniqueExcept.add(norm(role));
  }
  // An explicit printed cap on a role overrides the blanket "each operative once": the
  // Inquisitorial Agent prints "your kill team can only include each operative on this list once,
  // unless you're not including any REQUISITIONED operatives, in which case you can include up to
  // two GUN SERVITOR operatives", which scrapes as a `maxCount` of 2 alongside the uniqueness
  // constraint. Without this the cap and the uniqueness rule contradict each other and the role
  // can never be taken twice.
  const explicitCap = new Map<string, number>();
  for (const c of sel.constraints)
    if (c.kind === 'maxCount') {
      const cc = c as { role: string; max: number };
      explicitCap.set(norm(cc.role), cc.max);
    }
  /**
   * "Other than GUNNER and WARRIOR operatives, your kill team can only include each operative on
   * this list once." The exempt token is the ROLE KEYWORD, but a scraped row keeps whatever
   * sub-group prefix the page printed — "SKITARII RANGER GUNNER", "VANGUARD WARRIOR" — so exact
   * equality never matched and the printed exemption never fired, leaving Hunter Clade unable to
   * field a legal kill team.
   *
   * Matching is on SPACE-separated tokens, deliberately not substrings: the Kasrkin exempt
   * "TROOPER" must not also exempt RECON-TROOPER, VOX-TROOPER or DEMO-TROOPER, which are
   * different operatives that happen to end in the same word.
   */
  const isExemptRole = (role: string): boolean => {
    const n = norm(role);
    if (uniqueExcept.has(n)) return true;
    return n.split(/\s+/).some((token) => uniqueExcept.has(token));
  };
  const byIndex = new Map<number, number>();
  for (const r of resolved) byIndex.set(r.index, (byIndex.get(r.index) ?? 0) + 1);
  for (const [index, n] of byIndex) {
    const entry = selectionEntries(data)[index]!;
    if (n <= 1) continue;
    const cap = explicitCap.get(norm(entry.role));
    const exempt = isExemptRole(entry.role) || !entry.uniqueUnlessRole || (cap !== undefined && n <= cap);
    if (!exempt) {
      fail('unique', `your kill team can only include each operative on this list once — ${entry.role} selected ${n} times`);
    }
  }

  // "(each must have a different option)" — two picks of the same row cannot share a loadout.
  for (const c of sel.constraints) {
    if (c.kind !== 'distinctOptions') continue;
    const cc = c as unknown as { role: string };
    const role = norm(cc.role);
    const picksOfRole = resolved.filter((r) => norm(r.entry.role) === role);
    if (picksOfRole.length <= 1) continue;
    const keys = picksOfRole.map((r) =>
      [...(r.pick.loadoutIds ?? []), ...(r.pick.loadoutId ? [r.pick.loadoutId] : [])].sort().join('+'),
    );
    if (new Set(keys).size !== keys.length)
      fail('distinctOptions', `each ${cc.role} operative must have a different option`);
  }

  // ---- printed constraints -------------------------------------------------
  /**
   * "…can only include up to one GRAVIS operative."
   *
   * A printed cap names a role on the selection list most of the time, but sometimes it names a
   * datacard KEYWORD that several list rows share — the Deathwatch GRAVIS cap covers the
   * BOMBARD, BREACHER and HORDE-SLAYER rows. Matching only `entry.role` made that constraint
   * dead, and `defaultRoster` happily produced a two-GRAVIS kill team the validator accepted.
   * So: match the role first, and fall back to the keyword when no row carries that role.
   */
  const roleMatches = (entry: SelectionEntry, role: string): boolean => norm(entry.role) === norm(role);
  const anyRowHasRole = (role: string): boolean => selectionEntries(data).some((e) => roleMatches(e, role));
  const countRole = (role: string): number => {
    if (anyRowHasRole(role)) return resolved.filter((r) => roleMatches(r.entry, role)).length;
    return resolved.filter((r) => {
      const card = data.datacards.find((c) => c.id === r.entry.datacardId);
      return (card?.keywords ?? []).some((k) => norm(k) === norm(role));
    }).length;
  };
  for (const c of sel.constraints) {
    if (c.kind === 'maxCount') {
      const cc = c as { role: string; max: number };
      if (countRole(cc.role) > cc.max)
        fail('maxCount', `you cannot select more than ${cc.max} ${cc.role} operatives (${countRole(cc.role)} selected)`);
    } else if (c.kind === 'maxItem') {
      // "…can only include up to one fusion pistol", "…up to two darklight weapons". The
      // resolved weapon list per pick is already computed above, so this is a plain count.
      const cc = c as unknown as { item: string; max: number };
      const n = weapons.filter((ws) => ws.some((w) => norm(w) === norm(cc.item))).length;
      if (n > cc.max) fail('maxItem', `your kill team can only include up to ${cc.max} ${cc.item} (${n} selected)`);
    } else if (c.kind === 'exclusiveItems') {
      // "Your kill team cannot include both a blaster and a wraithcannon."
      const cc = c as unknown as { items: string[] };
      const present = cc.items.filter((item) => weapons.some((ws) => ws.some((w) => norm(w) === norm(item))));
      if (present.length > 1)
        fail('exclusiveItems', `your kill team cannot include both ${cc.items.join(' and ')}`);
    } else if (c.kind === 'requires') {
      const cc = c as { role: string; requiresRole: string };
      if (countRole(cc.role) > 0 && countRole(cc.requiresRole) === 0)
        fail('requires', `you can only select a ${cc.role} operative if your kill team includes a ${cc.requiresRole} operative`);
    } else if (c.kind === 'groupCap') {
      const cc = c as { group: string; max: number };
      const n = resolved.filter((r) => r.entry.footnoteGroup === cc.group).length;
      if (n > cc.max)
        fail('groupCap', `${sel.footnotes[cc.group] ?? `at most ${cc.max} of these operatives combined`} (${n} selected)`);
    } else if (c.kind === 'halfSelection') {
      const cc = c as { group: string; max: number };
      const cost = resolved.filter((r) => r.entry.footnoteGroup === cc.group).reduce((n, r) => n + r.entry.selectionCost, 0);
      if (cost > cc.max)
        fail('halfSelection', `${sel.footnotes[cc.group] ?? 'these operatives count as half a selection each'} (${cost} selections used)`);
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
  /**
   * `nth` is how many times this row has already been taken. A row that may be repeated under an
   * explicit cap usually also prints "(each must have a different option)", so the nth pick takes
   * the nth loadout where the row offers one — the Inquisitorial Agent's two GUN SERVITORs.
   */
  const pickOf = (entry: SelectionEntry, index: number, nth = 0): RosterPickIn => {
    const at = <T>(xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs[nth % xs.length]);
    return {
      datacardId: entry.datacardId,
      entryId: entryId(data, index),
      loadoutIds: [
        ...(entry.loadouts.length > 0 ? [at(entry.loadouts)!.id] : []),
        ...entry.optionGroups.map((g) => at(g.choices)?.id).filter((x): x is string => Boolean(x)),
        ...entry.fixedChoiceGroups.map((g) => at(g.choices)?.id).filter((x): x is string => Boolean(x)),
      ],
    };
  };

  // Leader group(s) first — every group whose entries are marked isLeader.
  entries.forEach((entry, index) => {
    if (!entry.isLeader) return;
    if (picks.some((p) => resolveEntry(data, p)?.entry.isLeader)) return;
    picks.push(pickOf(entry, index));
  });

  // Then fill each remaining group to its printed count, in list order.
  for (const group of groupTargets(data.selection)) {
    // Do NOT skip a group just because the leader belongs to it. When the leader is drawn
    // from the same list ("5 DEATHWATCH operatives selected from the following list: WATCH
    // SERGEANT, ..."), skipping left the roster with nothing but the leader. The leader's
    // pick is already counted in `filled` below, so a group of exactly one leader fills
    // itself and needs no special case.
    // An `every` group is a fixed roster: take each printed row exactly `count` times.
    if (group.kind === 'every') {
      entries.forEach((entry, index) => {
        // `isLeader` rows are already placed by the leader pass above — the leader of an `every`
        // roster is printed in both `leaderList` and `list` (as it is for any in-list leader).
        if (entry.group !== group.index || entry.isLeader) return;
        const have = picks.filter((p) => resolveEntry(data, p)?.index === index).length;
        for (let n = have; n < (entry.count ?? 1); n++) picks.push(pickOf(entry, index, n));
      });
      continue;
    }
    let filled = picks
      .map((p) => resolveEntry(data, p))
      .filter((r) => r && r.entry.group === group.index)
      .reduce((n, r) => n + (r ? r.entry.selectionCost : 0), 0);
    let guard = 0;
    while (filled < group.count && guard++ < 200) {
      let added = false;
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        if (entry.group !== group.index || entry.isLeader) continue;
        if (filled + entry.selectionCost > group.count) continue;
        // Try this row's options in turn, not just its first. A printed cap on a WEAPON
        // ("up to one fusion pistol") is broken by whichever option happens to sit first on
        // several rows, and always taking `loadouts[0]` made those teams unfillable — which is
        // why `maxItem` could not be enforced before (docs/DECISIONS.md D-030).
        const nth = picks.filter((p) => resolveEntry(data, p)?.index === index).length;
        const variants = Math.max(
          1,
          entry.loadouts.length,
          ...entry.optionGroups.map((g) => g.choices.length),
          ...entry.fixedChoiceGroups.map((g) => g.choices.length),
        );
        let chosen: RosterPickIn | undefined;
        for (let v = 0; v < variants && !chosen; v++) {
          const candidate = pickOf(entry, index, nth + v);
          const check = validateRosterFor(data, [...picks, candidate]);
          if (!check.codes.some((c) => !COUNT_CODES.includes(c))) chosen = candidate;
        }
        if (!chosen) continue;
        picks.push(chosen);
        filled += entry.selectionCost;
        added = true;
        break;
      }
      if (!added) break;
    }
  }
  return picks;
}
