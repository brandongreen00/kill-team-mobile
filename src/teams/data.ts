/**
 * Typed access to the scraped, normalised kill-team data in `data/teams/<slug>.json`.
 *
 * The JSON is the single source of truth for every printed string a team module quotes:
 * faction rules, ploys, equipment, abilities, unique actions and the selection block.
 * A team module NEVER hard-codes rule text — it reads it from here, so the in-app rule
 * tooltip and the tests are pinned to the same bytes.
 *
 * **This module holds no JSON.** The implemented teams' bundled data lives in `bundled.ts`,
 * which the team modules import; everything here is types and pure helpers, so the roster
 * builder can read a team's shape without dragging every bundled kill team into the entry
 * chunk (that alone was ~380 kB of the first paint).
 */
import type { Datacard } from '../core/types.ts';

export interface LoadoutOption {
  id: string;
  label: string;
  weapons: string[];
}

export interface OptionGroup {
  id: string;
  label: string;
  choices: LoadoutOption[];
}

/** One row of a kill team's selection list ("GUNNER with meltagun and gun butt*"). */
export interface SelectionEntry {
  role: string;
  datacardId: string;
  count: number;
  group: number;
  isLeader: boolean;
  /** "Other than TROOPER operatives, your kill team can only include each operative once." */
  uniqueUnlessRole: boolean;
  /** Half-selection operatives (BOMB SQUIG, GROT, C.A.T. UNIT, GHEISTSKULL) cost 0.5. */
  selectionCost: number;
  /** Footnote group the entry belongs to ('*'), used by group caps. */
  footnoteGroup: string | null;
  /** Roles this entry cannot be selected without. */
  requires: string[];
  loadoutMode: string;
  fixedWeapons: string[];
  alwaysWeapons: string[];
  loadouts: LoadoutOption[];
  optionGroups: OptionGroup[];
  fixedChoiceGroups: OptionGroup[];
  rawText: string;
  /** Set on entries that come from a faction rule's requisition group, never the printed list. */
  requisitionGroup?: string;
}

/**
 * One group of REQUISITIONED operatives — a selection list printed inside a *faction rule*
 * rather than in the Operatives section ("REQUISITIONED operatives can be taken from one of
 * the following groups… DEATH KORPS, EXACTION SQUAD, …"). Its datacards are printed either on
 * this team's own page (`sourceTeam: null`) or on the donor kill team's page.
 */
export interface RequisitionGroup {
  id: string;
  name: string;
  keyword: string;
  /** The kill team whose committed JSON holds these datacards, or null when this team has them. */
  sourceTeam: string | null;
  count: number;
  rawText: string;
  entries: SelectionEntry[];
  constraints: SelectionConstraint[];
  footnotes: Record<string, string>;
  /** Roles the pipeline could not resolve to a real datacard — surfaced, never invented. */
  unresolved: string[];
}

export interface RequisitionBlock {
  ruleId: string;
  ruleName: string;
  /** "REQUISITIONED". */
  keyword: string;
  oneGroupOnly: boolean;
  rawText: string;
  /** "…have their faction keyword replaced in all instances on their datacards with X." */
  factionKeyword?: string;
  keywordRuleText?: string;
  groups: RequisitionGroup[];
}

export type SelectionConstraint =
  | { kind: 'uniqueExcept'; roles: string[] }
  | { kind: 'maxCount'; role: string; max: number }
  /** "…up to one COMBAT SERVITOR operative **with meltagun**" — a cap on the option, not the role. */
  | { kind: 'maxCountWithWeapon'; role: string; weapon: string; max: number; text?: string }
  | { kind: 'requires'; role: string; requiresRole: string }
  | { kind: 'groupCap'; group: string; max: number }
  | { kind: 'halfSelection'; group: string; max: number }
  /** "you cannot select REQUISITIONED operatives from different groups" */
  | { kind: 'oneRequisitionGroup'; keyword: string; text: string }
  /**
   * "…can only include each operative on this list once, **unless** you're not including any
   * REQUISITIONED operatives, in which case you can include up to two GUN SERVITOR
   * operatives, but each one must have different options."
   */
  | { kind: 'uniqueUnlessAlternative'; alternative: string; role: string; max: number; distinctOptions: boolean; text: string }
  | { kind: string; [k: string]: unknown };

export interface SelectionBlock {
  leader: {
    role: string;
    datacardId: string;
    count: number;
    /**
     * True when the leader is printed as one entry of the same list the other operatives are
     * drawn from ("5 DEATHWATCH operatives selected from the following list: WATCH SERGEANT,
     * ..."), so it consumes one of the N rather than sitting on top of it.
     */
    inList?: boolean;
  };
  slots: number;
  totalOperatives: number;
  groups: {
    index: number;
    count: number;
    kind: string;
    roles: string[];
    rawText: string;
    /** "N operatives selected from **the list above**" — the group whose entries it offers. */
    drawsFrom?: number;
    /** This group may also be filled from `selection.requisition`. */
    requisition?: boolean;
  }[];
  list: SelectionEntry[];
  leaderList: SelectionEntry[];
  constraints: SelectionConstraint[];
  requisition?: RequisitionBlock;
  footnotes: Record<string, string>;
  designerNotes?: string[];
  rawText: string;
}

export interface TeamRuleText {
  id: string;
  name: string;
  text: string;
  fluff?: string;
}

export interface TeamPloyText extends TeamRuleText {
  cp: number;
}

export interface TeamData {
  id: string;
  name: string;
  faction: string;
  archetypes: string[];
  sourceUrl: string;
  selection: SelectionBlock;
  datacards: Datacard[];
  factionRules: TeamRuleText[];
  strategyPloys: TeamPloyText[];
  firefightPloys: TeamPloyText[];
  equipment: TeamRuleText[];
  rareWeaponRules: string[];
  markerGuide?: string;
}

/**
 * The normaliser appends the following page section to the LAST entry of a section
 * (a scraping artefact — see the report). Everything from a section heading onwards is
 * not part of that rule, so it is trimmed here rather than being quoted into the app.
 */
const SECTION_HEADINGS = [
  '\nFirefight Ploys\n',
  '\nStrategy Ploys\n',
  '\nFaction Equipment\n',
  '\nFaction Rules\n',
];

export function trimTrailingSection(text: string): string {
  let out = text;
  for (const heading of SECTION_HEADINGS) {
    const at = out.indexOf(heading);
    if (at >= 0) out = out.slice(0, at);
  }
  return out.trim();
}

export function normaliseTeam(raw: unknown): TeamData {
  const data = raw as TeamData;
  const fix = <T extends TeamRuleText>(r: T): T => ({ ...r, text: trimTrailingSection(r.text) });
  return {
    ...data,
    factionRules: data.factionRules.map(fix),
    strategyPloys: data.strategyPloys.map(fix),
    firefightPloys: data.firefightPloys.map(fix),
    equipment: data.equipment.map(fix),
  };
}

/**
 * All selection entries (leader group first), which is what the roster validator walks.
 *
 * REQUISITIONED entries are appended in printed group order and are ALWAYS included, whether
 * or not their donor kill team's datacards have been merged in: entry ids are positional, so
 * a saved roster must not shift when a donor is or is not loaded. An entry whose datacard is
 * absent is refused by `validateRosterFor`, not hidden.
 */
const ENTRY_CACHE = new WeakMap<TeamData, SelectionEntry[]>();

export function selectionEntries(data: TeamData): SelectionEntry[] {
  // Memoised per team object: this is on the hot path of every legality check, and a team
  // with REQUISITIONED groups has ~70 entries. Pure — the same input gives the same array.
  const hit = ENTRY_CACHE.get(data);
  if (hit) return hit;
  const out = [
    ...data.selection.leaderList,
    ...data.selection.list,
    ...(data.selection.requisition?.groups ?? []).flatMap((g) => g.entries),
  ];
  ENTRY_CACHE.set(data, out);
  return out;
}

/** The REQUISITIONED groups a faction rule offers, or [] when the team has none. */
export function requisitionGroups(data: TeamData): RequisitionGroup[] {
  return data.selection.requisition?.groups ?? [];
}

/** The printed text of one faction rule / ploy / equipment option, by id. */
export function ruleText(data: TeamData, id: string): string {
  const all: TeamRuleText[] = [
    ...data.factionRules,
    ...data.strategyPloys,
    ...data.firefightPloys,
    ...data.equipment,
  ];
  const found = all.find((r) => r.id === id);
  if (found) return found.text;
  for (const card of data.datacards) {
    const ability = card.abilities.find((a) => a.id === id);
    if (ability) return ability.text;
    const action = card.uniqueActions.find((a) => a.id === id);
    if (action) return action.text;
  }
  throw new Error(`No rule '${id}' in data/teams/${data.id}.json`);
}

/** A datacard by id, for tests and for `available()` predicates on unique actions. */
export function datacard(data: TeamData, id: string): Datacard {
  const c = data.datacards.find((x) => x.id === id);
  if (!c) throw new Error(`No datacard '${id}' in data/teams/${data.id}.json`);
  return c;
}
