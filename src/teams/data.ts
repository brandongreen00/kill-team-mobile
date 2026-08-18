/**
 * Typed access to the scraped, normalised kill-team data in `data/teams/<slug>.json`.
 *
 * The JSON is the single source of truth for every printed string a team module quotes:
 * faction rules, ploys, equipment, abilities, unique actions and the selection block.
 * A team module NEVER hard-codes rule text — it reads it from here, so the in-app rule
 * tooltip and the tests are pinned to the same bytes.
 */
import kasrkinJson from '../../data/teams/kasrkin.json';
import angelOfDeathJson from '../../data/teams/angel-of-death.json';
import plagueMarinesJson from '../../data/teams/plague-marines.json';
import imperialNavyBreacherJson from '../../data/teams/imperial-navy-breacher.json';
import celestianInsidiantsJson from '../../data/teams/celestian-insidiants.json';
import kommandosJson from '../../data/teams/kommandos.json';
import pathfindersJson from '../../data/teams/pathfinders.json';
import hierotekCircleJson from '../../data/teams/hierotek-circle.json';
// Batch 2 — Astartes & Heretic Astartes.
import scoutSquadJson from '../../data/teams/scout-squad.json';
import murderwingJson from '../../data/teams/murderwing.json';
import phobosStrikeTeamJson from '../../data/teams/phobos-strike-team.json';
import deathwatchJson from '../../data/teams/deathwatch.json';
import wolfScoutsJson from '../../data/teams/wolf-scouts.json';
import legionaryJson from '../../data/teams/legionary.json';
import nemesisClawJson from '../../data/teams/nemesis-claw.json';
import warpcovenJson from '../../data/teams/warpcoven.json';
// Batch 3 — Imperium, non-Astartes.
import deathKorpsJson from '../../data/teams/death-korps.json';
import exactionSquadJson from '../../data/teams/exaction-squad.json';
import novitiatesJson from '../../data/teams/novitiates.json';
import sanctifiersJson from '../../data/teams/sanctifiers.json';
import ratlingsJson from '../../data/teams/ratlings.json';
import inquisitorialAgentJson from '../../data/teams/inquisitorial-agent.json';
import elucidianStarstriderJson from '../../data/teams/elucidian-starstrider.json';
import spectreSquadJson from '../../data/teams/spectre-squad.json';
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
}

export type SelectionConstraint =
  | { kind: 'uniqueExcept'; roles: string[] }
  | { kind: 'maxCount'; role: string; max: number }
  | { kind: 'requires'; role: string; requiresRole: string }
  | { kind: 'groupCap'; group: string; max: number }
  | { kind: 'halfSelection'; group: string; max: number }
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
  groups: { index: number; count: number; kind: string; roles: string[]; rawText: string }[];
  list: SelectionEntry[];
  leaderList: SelectionEntry[];
  constraints: SelectionConstraint[];
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

function normalise(raw: unknown): TeamData {
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

export const TEAM_DATA: Record<string, TeamData> = {
  kasrkin: normalise(kasrkinJson),
  'angel-of-death': normalise(angelOfDeathJson),
  'plague-marines': normalise(plagueMarinesJson),
  'imperial-navy-breacher': normalise(imperialNavyBreacherJson),
  'celestian-insidiants': normalise(celestianInsidiantsJson),
  kommandos: normalise(kommandosJson),
  pathfinders: normalise(pathfindersJson),
  'hierotek-circle': normalise(hierotekCircleJson),
  'scout-squad': normalise(scoutSquadJson),
  murderwing: normalise(murderwingJson),
  'phobos-strike-team': normalise(phobosStrikeTeamJson),
  deathwatch: normalise(deathwatchJson),
  'wolf-scouts': normalise(wolfScoutsJson),
  legionary: normalise(legionaryJson),
  'nemesis-claw': normalise(nemesisClawJson),
  warpcoven: normalise(warpcovenJson),
  'death-korps': normalise(deathKorpsJson),
  'exaction-squad': normalise(exactionSquadJson),
  novitiates: normalise(novitiatesJson),
  sanctifiers: normalise(sanctifiersJson),
  ratlings: normalise(ratlingsJson),
  'inquisitorial-agent': normalise(inquisitorialAgentJson),
  'elucidian-starstrider': normalise(elucidianStarstriderJson),
  'spectre-squad': normalise(spectreSquadJson),
};

export function teamData(id: string): TeamData {
  const d = TEAM_DATA[id];
  if (!d) throw new Error(`Unknown kill team '${id}' — add data/teams/${id}.json to src/teams/data.ts`);
  return d;
}

export function teamDatacards(id: string): Datacard[] {
  return teamData(id).datacards;
}

/** All selection entries (leader group first), which is what the roster validator walks. */
export function selectionEntries(data: TeamData): SelectionEntry[] {
  return [...data.selection.leaderList, ...data.selection.list];
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
