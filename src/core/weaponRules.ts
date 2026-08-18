/**
 * Weapon-rule parsing + registry.
 *
 * Appendix › WEAPON RULES lists 23 universal rules. Anything else on a datacard is a RARE
 * rule belonging to a kill team; it must be registered by that team's module. An unknown
 * token is a data-lint failure (`assertKnownRules`), never a silent no-op.
 */
import type { WeaponRule, WeaponRuleId } from './types.ts';

export const UNIVERSAL_WEAPON_RULES = [
  'Accurate',
  'Balanced',
  'Blast',
  'Brutal',
  'Ceaseless',
  'Devastating',
  'Heavy',
  'Hot',
  'Lethal',
  'Limited',
  'Piercing',
  'PiercingCrits',
  'Punishing',
  'Range',
  'Relentless',
  'Rending',
  'Saturate',
  'Seek',
  'SeekLight',
  'Severe',
  'Shock',
  'Silent',
  'Stun',
  'Torrent',
] as const satisfies readonly WeaponRuleId[];

const UNIVERSAL_SET = new Set<string>(UNIVERSAL_WEAPON_RULES);

/**
 * Rare rules registered by team modules, with the verbatim text for the tooltip.
 *
 * The SAME rule id can be printed differently by different kill teams, so the text is kept per
 * team as well as generically. Anti-PSYKER is the proven case: the Novitiates' Condemnor prints
 * "…add 1 to both Dmg stats of this weapon and it has the Lethal 5+ weapon rule", while the
 * Celestian Insidiants' own footnote prints only "…it has the Lethal 5+ weapon rule"
 * (docs/DECISIONS.md D-025). Showing one team the other's wording is simply wrong.
 */
const rareRegistry = new Map<string, { text: string; teams: Set<string>; byTeam: Map<string, string> }>();

export function registerRareWeaponRule(id: string, text: string, teamId: string): void {
  const entry = rareRegistry.get(id) ?? { text, teams: new Set<string>(), byTeam: new Map<string, string>() };
  entry.text ||= text;
  entry.teams.add(teamId);
  if (text) entry.byTeam.set(teamId, text);
  rareRegistry.set(id, entry);
}

/** The verbatim definition as THIS kill team prints it, falling back to the generic one. */
export function rareWeaponRuleText(id: string, teamId?: string): string | undefined {
  const entry = rareRegistry.get(id);
  if (!entry) return undefined;
  return (teamId ? entry.byTeam.get(teamId) : undefined) ?? entry.text;
}

export function isKnownWeaponRule(id: string): boolean {
  return UNIVERSAL_SET.has(id) || rareRegistry.has(id);
}

export function rareWeaponRules(): { id: string; text: string; teams: string[]; byTeam: Record<string, string> }[] {
  return [...rareRegistry.entries()].map(([id, v]) => ({
    id,
    text: v.text,
    teams: [...v.teams],
    byTeam: Object.fromEntries(v.byTeam),
  }));
}

export function assertKnownRules(rules: WeaponRule[], where: string): void {
  for (const r of rules) {
    if (!isKnownWeaponRule(r.id)) {
      throw new Error(
        `Unknown weapon rule '${r.id}' (raw: '${r.raw}') on ${where}. ` +
          `Register it in the team module via registerRareWeaponRule() — weapon rules are never no-ops.`,
      );
    }
  }
}

/** Distance-prefixed Devastating, e.g. `1" Devastating 3`. */
const DEV_DIST = /^(\d+(?:\.\d+)?)"\s*Devastating\s*(\d+)$/i;
/** `Heavy (Dash only)` and friends. */
const HEAVY_ONLY = /^Heavy\s*\(([^)]+?)\s*only\)$/i;
const PIERCING_CRITS = /^Piercing\s+Crits\s*(\d+)?$/i;
const SEEK_LIGHT = /^Seek\s+Light$/i;
const NAME_X = /^([A-Za-z' ’-]+?)\s*(\d+(?:\.\d+)?)(\+|")?$/;

/**
 * Parse one rule token as printed on a datacard (e.g. `Lethal 5+`, `Blast 2"`, `Range 9"`).
 * Returns null for empty tokens; the caller decides whether that is an error.
 */
export function parseWeaponRule(rawInput: string): WeaponRule | null {
  const raw = rawInput.trim().replace(/’/g, "'").replace(/[”“]/g, '"');
  if (!raw) return null;

  let m = DEV_DIST.exec(raw);
  if (m) return { id: 'Devastating', x: Number(m[2]), dist: Number(m[1]), raw };

  m = HEAVY_ONLY.exec(raw);
  if (m) return { id: 'Heavy', only: m[1]!.trim(), raw };

  m = PIERCING_CRITS.exec(raw);
  if (m) return { id: 'PiercingCrits', x: m[1] ? Number(m[1]) : 1, raw };

  if (SEEK_LIGHT.test(raw)) return { id: 'SeekLight', raw };

  m = NAME_X.exec(raw);
  if (m) {
    const id = canonicalRuleId(m[1]!.trim());
    return { id, x: Number(m[2]), raw };
  }

  return { id: canonicalRuleId(raw), raw };
}

function canonicalRuleId(name: string): WeaponRuleId {
  const cleaned = name.replace(/\s+/g, ' ').trim();
  const pascal = cleaned
    .split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
  // Known aliases seen on datacards.
  const aliases: Record<string, WeaponRuleId> = {
    PiercingCrits: 'PiercingCrits',
    SeekLight: 'SeekLight',
  };
  return (aliases[pascal] ?? pascal) as WeaponRuleId;
}

/** Parse a comma/semicolon separated rules cell. */
export function parseWeaponRules(text: string): WeaponRule[] {
  if (!text) return [];
  return text
    .split(/[,;]/)
    .map((s) => parseWeaponRule(s))
    .filter((r): r is WeaponRule => r !== null);
}

/** Human-readable rendering, round-trips the printed form. */
export function formatWeaponRule(r: WeaponRule): string {
  if (r.raw) return r.raw;
  if (r.id === 'Devastating' && r.dist !== undefined) return `${r.dist}" Devastating ${r.x}`;
  if (r.id === 'PiercingCrits') return `Piercing Crits ${r.x ?? 1}`;
  if (r.id === 'SeekLight') return 'Seek Light';
  if (r.id === 'Heavy' && r.only) return `Heavy (${r.only} only)`;
  if (r.id === 'Lethal') return `Lethal ${r.x}+`;
  if (r.id === 'Range' || r.id === 'Blast' || r.id === 'Torrent') return `${r.id} ${r.x}"`;
  return r.x !== undefined ? `${r.id} ${r.x}` : r.id;
}

/**
 * Condensed Environment (Close Quarters): "Weapons with the Blast, Torrent and/or
 * x" Devastating weapon rule also have the Lethal 5+ weapon rule."
 */
export function condensedEnvironmentRules(rules: WeaponRule[]): WeaponRule[] {
  const triggers = rules.some(
    (r) => r.id === 'Blast' || r.id === 'Torrent' || (r.id === 'Devastating' && r.dist !== undefined),
  );
  if (!triggers) return rules;
  if (rules.some((r) => r.id === 'Lethal' && (r.x ?? 6) <= 5)) return rules;
  return [...rules, { id: 'Lethal' as const, x: 5, raw: 'Lethal 5+ (Condensed Environment)' }];
}
