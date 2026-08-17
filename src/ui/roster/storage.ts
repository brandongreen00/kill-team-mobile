/**
 * Named rosters in `localStorage`, plus JSON import/export.
 *
 * Deliberately outside `src/core/` — the rules core is pure and does no I/O. A saved roster is
 * exactly what `SelectRoster` wants (`teamId` + `RosterPick[]`), so an exported file is enough
 * to field the same kill team on another device.
 */
import type { RosterPickIn } from '../../teams/selection.ts';

export const STORAGE_KEY = 'kt24.rosters.v1';
export const EXPORT_FORMAT = 'kill-team-mobile/rosters@1';

export interface SavedRoster {
  id: string;
  name: string;
  teamId: string;
  picks: RosterPickIn[];
  savedAt: string;
}

export interface RosterFile {
  format: string;
  rosters: SavedRoster[];
}

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Safari private mode throws on access.
  }
}

export function loadRosters(): SavedRoster[] {
  const s = store();
  if (!s) return [];
  try {
    return sanitise(JSON.parse(s.getItem(STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function writeRosters(rosters: SavedRoster[]): SavedRoster[] {
  const s = store();
  try {
    s?.setItem(STORAGE_KEY, JSON.stringify(rosters));
  } catch {
    /* quota or private mode — the roster still works for this battle */
  }
  return rosters;
}

/** Save (or overwrite by name within the same kill team) and return the new library. */
export function saveRoster(roster: Omit<SavedRoster, 'id' | 'savedAt'> & Partial<SavedRoster>): SavedRoster[] {
  const existing = loadRosters();
  const id = roster.id ?? `${roster.teamId}.${roster.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const entry: SavedRoster = {
    id,
    name: roster.name,
    teamId: roster.teamId,
    picks: roster.picks,
    savedAt: new Date().toISOString(),
  };
  return writeRosters([entry, ...existing.filter((r) => r.id !== id)]);
}

export function deleteRoster(id: string): SavedRoster[] {
  return writeRosters(loadRosters().filter((r) => r.id !== id));
}

export function exportRosters(rosters: SavedRoster[]): string {
  return JSON.stringify({ format: EXPORT_FORMAT, rosters } satisfies RosterFile, null, 2);
}

/** Parse an exported file (or a bare array). Throws a player-facing message. */
export function parseRosters(text: string): SavedRoster[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('that is not valid JSON');
  }
  const list = Array.isArray(raw) ? raw : (raw as RosterFile)?.rosters;
  if (!Array.isArray(list)) throw new Error('no rosters in that file — expected {"rosters": [...]}');
  const out = sanitise(list);
  if (out.length === 0) throw new Error('no usable rosters in that file');
  return out;
}

/** Import, keeping both copies when a name clashes. */
export function importRosters(text: string): SavedRoster[] {
  const incoming = parseRosters(text);
  const existing = loadRosters();
  const merged = [...incoming];
  for (const r of existing) if (!merged.some((m) => m.id === r.id)) merged.push(r);
  return writeRosters(merged);
}

function sanitise(list: unknown): SavedRoster[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): SavedRoster[] => {
    const r = raw as Partial<SavedRoster>;
    if (typeof r?.teamId !== 'string' || !Array.isArray(r.picks)) return [];
    const picks = r.picks.filter((p): p is RosterPickIn => typeof (p as RosterPickIn)?.datacardId === 'string');
    if (picks.length === 0) return [];
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.teamId;
    return [
      {
        id: typeof r.id === 'string' && r.id ? r.id : `${r.teamId}.${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name,
        teamId: r.teamId,
        picks,
        savedAt: typeof r.savedAt === 'string' ? r.savedAt : new Date(0).toISOString(),
      },
    ];
  });
}
