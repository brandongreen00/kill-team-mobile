/**
 * Selection rules — one shared, data-driven validator for every kill team.
 * Each case quotes the printed selection requirement it pins.
 */
import { describe, expect, it } from 'vitest';
import { teamData } from '../../src/teams/data.ts';
import {
  alwaysAvailableWeapons,
  defaultRoster,
  entryId,
  resolveEntry,
  validateRosterFor,
  weaponsForPick,
} from '../../src/teams/selection.ts';
import { BATCH_1 } from '../../src/teams/index.ts';

describe('selection rules (shared, driven by data/teams/<slug>.json)', () => {
  for (const mod of BATCH_1) {
    it(`${mod.id}: the default roster is legal and fills every printed group`, () => {
      const picks = defaultRoster(mod.data);
      const result = mod.validateRoster(picks);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      // "N <TEAM> operatives selected from the following list" — leader + slots.
      const sel = mod.data.selection;
      expect(picks.length).toBeGreaterThanOrEqual(sel.slots);
    });

    it(`${mod.id}: an empty roster is rejected with a helpful message`, () => {
      const result = mod.validateRoster([]);
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toMatch(/must include exactly|select exactly/);
    });
  }

  it('KASRKIN: "Other than TROOPER operatives, your kill team can only include each operative on this list once"', () => {
    const data = teamData('kasrkin');
    const picks = defaultRoster(data);
    const medic = picks.find((p) => p.datacardId === 'kasrkin.combat-medic')!;
    const twice = [...picks.filter((p) => p.datacardId !== 'kasrkin.trooper'), { ...medic }];
    const result = validateRosterFor(data, twice);
    expect(result.errors.join(' ')).toContain('only include each operative on this list once');

    // TROOPER is the printed exception.
    const troopers = picks.filter((p) => p.datacardId === 'kasrkin.trooper');
    expect(validateRosterFor(data, [...picks, ...troopers]).errors.join(' ')).not.toContain(
      'only include each operative on this list once',
    );
  });

  it('KASRKIN: "You cannot select more than four of these operatives combined" (the * footnote)', () => {
    const data = teamData('kasrkin');
    const starred = data.selection.list
      .map((entry, i) => ({ entry, i }))
      .filter((x) => x.entry.footnoteGroup === '*');
    expect(starred.length).toBeGreaterThan(4);
    const leader = defaultRoster(data)[0]!;
    const picks = [
      leader,
      ...starred.slice(0, 5).map((x) => ({
        datacardId: x.entry.datacardId,
        entryId: entryId(data, data.selection.leaderList.length + x.i),
      })),
    ];
    expect(validateRosterFor(data, picks).errors.join(' ')).toContain('four of these operatives combined');
  });

  it('IMPERIAL NAVY BREACHERS: "you can only select a C.A.T. UNIT if your kill team includes a SURVEYOR"', () => {
    const data = teamData('imperial-navy-breacher');
    const entries = data.selection.list;
    const catIndex = entries.findIndex((e) => e.role === 'C.A.T. UNIT');
    const offset = data.selection.leaderList.length;
    const leader = defaultRoster(data)[0]!;
    const picks = [leader, { datacardId: entries[catIndex]!.datacardId, entryId: entryId(data, offset + catIndex) }];
    expect(validateRosterFor(data, picks).errors.join(' ')).toContain('SURVEYOR');
  });

  it('IMPERIAL NAVY BREACHERS: "These operatives count as half a selection each"', () => {
    const data = teamData('imperial-navy-breacher');
    const half = data.selection.list.filter((e) => e.selectionCost === 0.5).map((e) => e.role);
    expect(half).toEqual(expect.arrayContaining(['C.A.T. UNIT', 'GHEISTSKULL']));
  });

  it('PATHFINDERS: "you cannot select more than 2 WEAPONS EXPERT operatives"', () => {
    const data = teamData('pathfinders');
    const idx = data.selection.list.findIndex((e) => e.role === 'WEAPONS EXPERT');
    const offset = data.selection.leaderList.length;
    const expert = { datacardId: data.selection.list[idx]!.datacardId, entryId: entryId(data, offset + idx) };
    const picks = [defaultRoster(data)[0]!, expert, { ...expert }, { ...expert }];
    expect(validateRosterFor(data, picks).errors.join(' ')).toMatch(/more than 2 WEAPONS EXPERT/);
  });

  it('a weapon no selection option names is always available, including Limited x weapons', () => {
    const data = teamData('imperial-navy-breacher');
    const grenadier = data.datacards.find((c) => c.id === 'imperial-navy-breacher.navis-grenadier')!;
    const entry = data.selection.list.find((e) => e.role === 'GRENADIER')!;
    const weapons = weaponsForPick(data, entry, { datacardId: grenadier.id });
    // The demolition charge is Limited 1 and needs no choice.
    expect(weapons).toContain('Demolition charge');
    expect(weapons).toContain('Navis shotgun');
    expect(weapons).toContain('Navis hatchet');
    const limited = grenadier.weapons
      .find((w) => w.name === 'Demolition charge')!
      .profiles.some((p) => p.rules.some((r) => r.id === 'Limited'));
    expect(limited).toBe(true);
  });

  it('an entry with "one of the following options" grants exactly that option', () => {
    const data = teamData('kasrkin');
    const sergeant = data.selection.leaderList[0]!;
    const boltPistol = sergeant.loadouts.find((l) => l.label.startsWith('Bolt pistol'))!;
    const weapons = weaponsForPick(data, sergeant, { datacardId: sergeant.datacardId, loadoutId: boltPistol.id });
    expect(weapons.sort()).toEqual(['Bolt pistol', 'Power weapon']);
    // The other options' weapons are named elsewhere in the list, so they are NOT available.
    expect(weapons).not.toContain('Plasma pistol');
    expect(alwaysAvailableWeapons(data, data.datacards.find((c) => c.id === sergeant.datacardId)!)).toEqual([]);
  });

  it('several list rows can share a datacard and are told apart by their fixed weapons', () => {
    const data = teamData('kasrkin');
    const melta = resolveEntry(data, { datacardId: 'kasrkin.gunner', weapons: ['Meltagun', 'Gun butt'] });
    expect(melta?.entry.fixedWeapons).toEqual(['Meltagun', 'Gun butt']);
    const flamer = resolveEntry(data, { datacardId: 'kasrkin.gunner', weapons: ['Flamer', 'Gun butt'] });
    expect(flamer?.entry.fixedWeapons).toEqual(['Flamer', 'Gun butt']);
  });
});
