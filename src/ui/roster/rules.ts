/**
 * Roster-builder helpers — UI side, pure, no DOM.
 *
 * Legality is NOT decided here: `src/teams/selection.ts` is the one validator for every kill
 * team's printed selection requirements, and this module drives it. What lives here is the
 * arithmetic the screen needs around it (slots used per printed group, which "+ Add" buttons
 * are live and why not) and an honest list of the printed constraints that validator cannot
 * express, so they are surfaced as warnings instead of silently ignored.
 */
import {
  COUNT_CODES,
  eachGroups,
  entryId,
  groupUsage,
  isEitherEntry,
  modeOfPick,
  validateRosterFor,
  weaponsForPick,
  type LoadoutMode,
  type RosterPickIn,
  type RosterValidation,
} from '../../teams/selection.ts';
import { requisitionGroups, selectionEntries, type SelectionEntry, type TeamData } from '../../teams/data.ts';
import type { Datacard } from '../../core/types.ts';

export type { LoadoutMode, RosterPickIn, RosterValidation, SelectionEntry, TeamData };
export { isEitherEntry, modeOfPick };

/** Constraint kinds the shared validator understands (`validateRosterFor`). */
const ENFORCED_KINDS = new Set([
  'uniqueExcept',
  'uniqueUnlessAlternative',
  'maxCount',
  'maxCountWithWeapon',
  'requires',
  'groupCap',
  'halfSelection',
  'oneRequisitionGroup',
]);
/** Baked into each entry's `selectionCost` by the normaliser, so it needs no separate check. */
const APPLIED_TO_ENTRIES = new Set(['selectionCost']);

/**
 * The bundled team JSON already has the shape the validator wants; `src/ui/data.ts` types it
 * loosely (`selection?: unknown`) because most of the app does not care. Teams whose data has
 * no selection block cannot be built and are reported as such.
 */
export function asTeamData(
  team: { id: string; selection?: unknown; datacards?: unknown } | null | undefined,
): TeamData | null {
  if (!team || !team.selection || !Array.isArray(team.datacards)) return null;
  return team as unknown as TeamData;
}

export interface EntryRow {
  index: number;
  id: string;
  entry: SelectionEntry;
  card: Datacard | undefined;
}

export function entryRows(data: TeamData): EntryRow[] {
  return selectionEntries(data).map((entry, index) => ({
    index,
    id: entryId(data, index),
    entry,
    card: data.datacards.find((c) => c.id === entry.datacardId),
  }));
}

export function rowFor(data: TeamData, pick: RosterPickIn): EntryRow | undefined {
  return entryRows(data).find((r) => r.id === pick.entryId);
}

export interface ChoiceGroup {
  id: string;
  label: string;
  choices: { id: string; label: string; weapons: string[] }[];
}

/**
 * Every choice an entry offers: `loadouts` (pick one) and each option group (pick one from
 * each). For an **either** entry the two halves are alternatives, so the pickers are those
 * of the mode the pick has committed to — the screen asks which mode first.
 */
export function choiceGroups(entry: SelectionEntry, mode?: LoadoutMode | null): ChoiceGroup[] {
  const out: ChoiceGroup[] = [];
  const optionsGroup: ChoiceGroup = {
    id: `${entry.datacardId}.loadouts`,
    label: 'One of the following options',
    choices: entry.loadouts,
  };
  if (isEitherEntry(entry)) {
    if (mode === 'each') return eachGroups(entry);
    return [optionsGroup];
  }
  if (entry.loadouts.length > 0) out.push(optionsGroup);
  for (const g of eachGroups(entry)) out.push(g);
  return out;
}

/** The two printed halves of an `either` entry, in printed order. */
export function loadoutModes(entry: SelectionEntry): { id: LoadoutMode; label: string }[] {
  return [
    { id: 'options', label: `One of: ${entry.loadouts.map((l) => l.label).join(' / ')}` },
    { id: 'each', label: `One option from each of: ${eachGroups(entry).map((g) => g.label).join(' + ')}` },
  ];
}

/**
 * Switch an `either` entry to the other printed mode: the abandoned half's choices are
 * dropped (taking one from each half is exactly what the printed "Or" forbids) and the new
 * half is seeded with its first option, so the operative is never left half-equipped.
 */
export function withMode(entry: SelectionEntry, pick: RosterPickIn, mode: LoadoutMode): RosterPickIn {
  const keep = mode === 'options' ? entry.loadouts : eachGroups(entry).flatMap((g) => g.choices);
  const keepIds = new Set(keep.map((c) => c.id));
  const kept = (pick.loadoutIds ?? []).filter((id) => keepIds.has(id));
  const seed =
    mode === 'options'
      ? kept.length > 0
        ? []
        : entry.loadouts.slice(0, 1).map((l) => l.id)
      : eachGroups(entry)
          .filter((g) => !g.choices.some((c) => kept.includes(c.id)))
          .map((g) => g.choices[0]?.id)
          .filter((x): x is string => Boolean(x));
  const has = new Set(kept);
  return { ...pick, loadoutIds: [...kept, ...seed.filter((id) => !has.has(id))] };
}

export function defaultLoadoutIds(entry: SelectionEntry): string[] {
  // `either` entries default to the printed options list; the player can switch modes.
  if (isEitherEntry(entry)) return entry.loadouts[0] ? [entry.loadouts[0].id] : [];
  return choiceGroups(entry)
    .map((g) => g.choices[0]?.id)
    .filter((x): x is string => Boolean(x));
}

export function pickFor(data: TeamData, index: number): RosterPickIn {
  const entry = selectionEntries(data)[index]!;
  return { datacardId: entry.datacardId, entryId: entryId(data, index), loadoutIds: defaultLoadoutIds(entry) };
}

/** Swap one choice inside a group, leaving the other groups' choices alone. */
export function withChoice(pick: RosterPickIn, group: { choices: { id: string }[] }, choiceId: string): RosterPickIn {
  const others = group.choices.map((c) => c.id);
  const kept = (pick.loadoutIds ?? []).filter((id) => !others.includes(id));
  return { ...pick, loadoutIds: [...kept, choiceId] };
}

export function weaponsOfPick(data: TeamData, pick: RosterPickIn): string[] {
  const row = rowFor(data, pick);
  return row ? weaponsForPick(data, row.entry, pick) : [];
}

// ---------------------------------------------------------------------------
// Counting — the numbers on the legality panel and the add buttons
// ---------------------------------------------------------------------------

export interface Usage {
  leader: { used: number; need: number };
  /** "N further operatives selected from the following list" — the non-leader selections. */
  slots: { used: number; total: number };
  total: { used: number; max: number };
  groups: { index: number; count: number; used: number; rawText: string }[];
  operatives: number;
}

export function usage(data: TeamData, picks: RosterPickIn[]): Usage {
  const rows = picks.map((p) => rowFor(data, p)).filter((r): r is EntryRow => Boolean(r));
  const cost = (list: EntryRow[]) => list.reduce((n, r) => n + r.entry.selectionCost, 0);
  // A group printed as "selected from the list above" is filled by the SOURCE group's rows,
  // so the counting has to let those picks spill over — see `groupUsage`.
  const used = groupUsage(data, rows.map((r) => r.entry));
  return {
    leader: { used: rows.filter((r) => r.entry.isLeader).length, need: data.selection.leader?.count ?? 1 },
    slots: { used: cost(rows.filter((r) => !r.entry.isLeader)), total: data.selection.slots },
    total: { used: cost(rows), max: data.selection.totalOperatives },
    groups: (data.selection.groups ?? []).map((g) => ({
      index: g.index,
      count: g.count,
      used: used.get(g.index) ?? 0,
      rawText: g.rawText.trim(),
    })),
    operatives: picks.length,
  };
}

/** Errors that are real rule violations rather than "the roster is not finished yet". */
export function blockingErrors(v: RosterValidation): string[] {
  return v.errors.filter((_, i) => !COUNT_CODES.includes(v.codes[i] ?? ''));
}

export interface Addability {
  ok: boolean;
  reason?: string;
}

/**
 * May this entry be added to the roster as it stands? A trial run through the shared
 * validator answers every printed constraint (uniqueness, `requires`, footnote group caps,
 * half selections, role maximums); the counting above answers "there is no room left".
 */
export function addability(
  data: TeamData,
  picks: RosterPickIn[],
  index: number,
  /** The roster's current blocking errors, precomputed once when checking a whole list. */
  current?: Set<string>,
): Addability {
  const entry = selectionEntries(data)[index]!;
  const u = usage(data, picks);
  const cost = entry.selectionCost;
  if (entry.isLeader && u.leader.used + 1 > u.leader.need)
    return { ok: false, reason: `your kill team already includes its ${data.selection.leader?.role ?? 'LEADER'}` };
  if (!entry.isLeader && u.slots.used + cost > u.slots.total)
    return { ok: false, reason: `no selections left — ${u.slots.total} operatives besides the leader` };
  // Ask the same counting the legality panel uses, so a row that a later "…selected from the
  // list above" group can still absorb stays offered instead of reading as a full group.
  const trial = [...picks, pickFor(data, index)];
  const overfull = usage(data, trial).groups.find((g) => g.used > g.count);
  if (overfull) return { ok: false, reason: `${overfull.rawText} — that group is full` };
  if (u.total.max && u.total.used + cost > u.total.max)
    return { ok: false, reason: `a ${data.name} kill team is ${u.total.max} operatives at most` };

  const before = current ?? new Set(blockingErrors(validateRosterFor(data, picks)));
  const introduced = blockingErrors(validateRosterFor(data, trial)).find((e) => !before.has(e));
  return introduced ? { ok: false, reason: introduced } : { ok: true };
}

// ---------------------------------------------------------------------------
// What the shared validator cannot express — surfaced, never swallowed
// ---------------------------------------------------------------------------

export interface RosterWarning {
  /** 'constraint' = printed but unenforced · 'entry' = an entry the validator reads loosely. */
  kind: 'constraint' | 'entry' | 'support';
  text: string;
}

/** Printed constraints with no machine check behind them (docs/TEAM-DATA.md §5). */
export function unenforcedConstraints(data: TeamData): RosterWarning[] {
  const out: RosterWarning[] = [];
  const printed = [
    ...data.selection.constraints,
    // Each REQUISITIONED group prints its own rules; the ones with no machine check
    // ("Permitted EXACTION SQUAD faction rules: …") are surfaced here like any other.
    ...requisitionGroups(data).flatMap((g) => g.constraints),
  ];
  for (const c of printed) {
    if (ENFORCED_KINDS.has(c.kind) || APPLIED_TO_ENTRIES.has(c.kind)) continue;
    const r = c as { text?: string; item?: string; max?: number; role?: string; items?: string[] };
    let text: string;
    if (r.text) text = r.text;
    else if (c.kind === 'maxItem') text = `Your kill team can only include up to ${r.max} ${r.item}.`;
    else if (c.kind === 'exclusiveItems') text = `Your kill team cannot include both a ${(r.items ?? []).join(' and a ')}.`;
    else if (c.kind === 'distinctOptions') text = `Each ${r.role} operative must have a different option.`;
    else text = JSON.stringify(c);
    out.push({ kind: 'constraint', text });
  }
  return out;
}

/**
 * Entries printed as "…; **Or** one option from each of the following". The screen asks which
 * printed half is being taken before showing that half's pickers (`loadoutModes`/`withMode`),
 * and `validateRosterFor` rejects a pick that takes choices from both — so these are
 * enforced, not warned about.
 */
export function eitherEntries(data: TeamData): SelectionEntry[] {
  return selectionEntries(data).filter(isEitherEntry);
}

/**
 * Structural contradictions: selection lists whose printed shape the shared validator's slot
 * arithmetic cannot satisfy, so *no* roster it accepts exists. Detected from the data rather
 * than a hard-coded team list, and reported to the player instead of pretending.
 */
export function supportProblems(data: TeamData): string[] {
  const sel = data.selection;
  const entries = selectionEntries(data);
  const out: string[] = [];
  const groups = sel.groups ?? [];
  const groupSum = groups.reduce((n, g) => n + g.count, 0);
  const leaderCount = sel.leader?.count ?? 1;

  // A leader drawn from the same list as everyone else consumes one of the printed
  // selections rather than sitting on top of them, and the validator now counts it that way
  // (`selection.ts`, leaderInList). Only flag the arithmetic when the leader is genuinely
  // additional — otherwise every such team was reported as unsupported despite validating.
  if (groups.length > 0 && sel.leader?.inList !== true && leaderCount + sel.slots > groupSum) {
    out.push(
      `the leader is chosen from the same list as everyone else, and the shared validator counts it on top of the ${sel.slots} printed selections — no roster can satisfy both`,
    );
  }
  for (const g of groups) {
    const inGroup = entries.filter((e) => e.group === g.index);
    // "N operatives selected from the list above, or REQUISITIONED operatives from one
    // group": the reachable total is the source list's spare capacity, or the best single
    // REQUISITIONED group — never their sum, because only one group may be used.
    const sources: number[] = [maxAchievable(data, inGroup)];
    if (g.drawsFrom !== undefined) {
      const src = groups.find((x) => x.index === g.drawsFrom);
      if (src) sources.push(maxAchievable(data, entries.filter((e) => e.group === src.index)) - src.count);
    }
    for (const req of requisitionGroups(data))
      sources.push(maxAchievable(data, req.entries, req.constraints));
    if (inGroup.length === 0 && g.drawsFrom === undefined && g.count > 0) {
      out.push(`"${g.rawText.trim()}" has no entries on the selection list (its operatives come from a faction rule)`);
      continue;
    }
    if (Math.max(...sources) < g.count)
      out.push(`"${g.rawText.trim()}" cannot be filled: the list plus its printed maximums allow fewer selections than that`);
  }
  return out;
}

/**
 * The largest total selection cost a set of entries can reach under uniqueness + role caps.
 * A REQUISITIONED group carries its own printed constraints, so they can be passed in.
 */
function maxAchievable(
  data: TeamData,
  entries: SelectionEntry[],
  scoped?: readonly { kind: string; [k: string]: unknown }[],
): number {
  const norm = (s: string) => s.trim().toLowerCase();
  const exempt = new Set<string>();
  const roleMax = new Map<string, number>();
  for (const c of scoped ?? data.selection.constraints) {
    if (c.kind === 'uniqueExcept') for (const r of (c as { roles: string[] }).roles) exempt.add(norm(r));
    if (c.kind === 'maxCount') {
      const cc = c as { role: string; max: number };
      roleMax.set(norm(cc.role), Math.min(roleMax.get(norm(cc.role)) ?? Infinity, cc.max));
    }
    // `maxCountWithWeapon` is deliberately NOT a role cap: "up to one COMBAT SERVITOR
    // operative with meltagun" limits that option, not how many COMBAT SERVITORs the kill
    // team may field. Treating it as one is what made BATTLECLADE's 8-operative group
    // look unfillable.
  }
  const byRole = new Map<string, SelectionEntry[]>();
  for (const e of entries) {
    const key = norm(e.role);
    byRole.set(key, [...(byRole.get(key) ?? []), e]);
  }
  let total = 0;
  for (const [role, list] of byRole) {
    const copies = list.reduce((n, e) => n + (e.uniqueUnlessRole && !exempt.has(role) ? 1 : 99), 0);
    const allowed = Math.min(copies, roleMax.get(role) ?? Infinity);
    total += allowed * Math.max(...list.map((e) => e.selectionCost));
  }
  return total;
}

/**
 * What a REQUISITIONED group cannot offer, said out loud: a role the pipeline could not tie
 * to a real datacard, and a donor kill team whose JSON is not loaded here. Transcribe, never
 * invent — an operative the data cannot produce is reported, not made up.
 */
export function requisitionNotes(data: TeamData, missingDonors: string[] = []): RosterWarning[] {
  const out: RosterWarning[] = [];
  for (const g of requisitionGroups(data)) {
    if (g.unresolved.length > 0)
      out.push({
        kind: 'support',
        text: `${g.name}: ${g.unresolved.join(', ')} could not be matched to a printed datacard, so ${g.unresolved.length === 1 ? 'it is' : 'they are'} not offered.`,
      });
    if (g.sourceTeam && missingDonors.includes(g.sourceTeam))
      out.push({
        kind: 'support',
        text: `${g.name}: these datacards are printed with the ${g.name} kill team, whose data is not loaded — its operatives cannot be selected here.`,
      });
  }
  return out;
}

export function warningsFor(data: TeamData, missingDonors: string[] = []): RosterWarning[] {
  return [
    ...supportProblems(data).map((text): RosterWarning => ({ kind: 'support', text })),
    ...requisitionNotes(data, missingDonors),
    ...unenforcedConstraints(data),
  ];
}
