/**
 * Selection rules — one shared, data-driven validator for every kill team.
 * Each case quotes the printed selection requirement it pins.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { teamData, type TeamData } from '../../src/teams/data.ts';
import {
  alwaysAvailableWeapons,
  defaultRoster,
  entryId,
  resolveEntry,
  validateRosterFor,
  weaponsForPick,
} from '../../src/teams/selection.ts';
import { ALL_TEAM_MODULES } from '../../src/teams/index.ts';

describe('selection rules (shared, driven by data/teams/<slug>.json)', () => {
  for (const mod of ALL_TEAM_MODULES) {
    it(`${mod.id}: the default roster is legal and fills every printed group`, () => {
      const picks = defaultRoster(mod.data);
      const result = mod.validateRoster(picks);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      // "N <TEAM> operatives selected from the following list" — leader + slots, counted in
      // SELECTIONS, not in picks. An entry can cost 2 ("these operatives count as two selections
      // each" — Wyrmblade) or 0.5 (the Breachers' C.A.T. UNIT and GHEISTSKULL), so a pick count
      // is not the printed quantity. Wyrmblade fills 13 slots with 11 operatives.
      const sel = mod.data.selection;
      const cost = picks.reduce((n, p) => n + (resolveEntry(mod.data, p)?.entry.selectionCost ?? 1), 0);
      expect(cost).toBeGreaterThanOrEqual(sel.slots);
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

  it('INQUISITORIAL AGENT: "5 … selected from the list above" — a sameAsAbove group draws from the list it refers back to', () => {
    const data = teamData('inquisitorial-agent');
    // The printed second block is `kind: 'sameAsAbove'` with no selection entries of its own, so
    // counting it as a separate group made it unfillable and the team impossible to field.
    const same = data.selection.groups.find((g) => g.kind === 'sameAsAbove')!;
    expect(same.count).toBe(5);
    expect(data.selection.list.some((e) => e.group === same.index)).toBe(false);
    const picks = defaultRoster(data);
    const v = validateRosterFor(data, picks);
    expect(v.errors).toEqual([]);
    expect(picks).toHaveLength(data.selection.totalOperatives);
  });

  it('INQUISITORIAL AGENT: an explicit printed cap beats the blanket "each operative once"', () => {
    // "…your kill team can only include each operative on this list once, unless you're not
    // including any REQUISITIONED operatives, in which case you can include up to two GUN
    // SERVITOR operatives, but each one must have different options."
    const data = teamData('inquisitorial-agent');
    expect(data.selection.constraints).toContainEqual({ kind: 'maxCount', role: 'GUN SERVITOR', max: 2 });
    const servitors = defaultRoster(data).filter((p) => p.datacardId === 'inquisitorial-agent.requisitioned-gun-servitor');
    expect(servitors).toHaveLength(2);
    // "…but each one must have different options."
    const opts = servitors.map((p) => (p.loadoutIds ?? []).join('+'));
    expect(new Set(opts).size).toBe(2);
  });

  it('EXACTION SQUAD: "you can only include up to two GUNNER operatives (each must have a different option)"', () => {
    const data = teamData('exaction-squad');
    expect(data.selection.constraints).toContainEqual({ kind: 'distinctOptions', role: 'GUNNER' });
    const offset = data.selection.leaderList.length;
    const idx = data.selection.list.findIndex((e) => e.role === 'GUNNER');
    const entry = data.selection.list[idx]!;
    const gunner = (optId: string) => ({
      datacardId: entry.datacardId,
      entryId: entryId(data, offset + idx),
      loadoutIds: [optId],
    });
    const base = defaultRoster(data).filter((p) => p.datacardId !== entry.datacardId);

    // Two GUNNERs with DIFFERENT options: the distinctOptions rule is satisfied.
    const differing = validateRosterFor(data, [...base, gunner(entry.loadouts[0]!.id), gunner(entry.loadouts[1]!.id)]);
    expect(differing.errors.join(' ')).not.toContain('must have a different option');

    // The same option twice is refused.
    const same = validateRosterFor(data, [...base, gunner(entry.loadouts[0]!.id), gunner(entry.loadouts[0]!.id)]);
    expect(same.ok).toBe(false);
    expect(same.errors.join(' ')).toContain('each GUNNER operative must have a different option');
  });

  it('ELUCIDIAN STARSTRIDER: "Every ELUCIDIAN STARSTRIDER operative in the following list" is a FIXED roster', () => {
    const data = teamData('elucidian-starstrider');
    const group = data.selection.groups.find((g) => g.kind === 'every')!;
    expect(group.rawText).toContain('Every');
    // Each printed row must appear exactly its own `count` times — checking only the group total
    // let the default roster field ELUCIA VHANE plus nine CANIDs and call it legal.
    const picks = defaultRoster(data);
    expect(validateRosterFor(data, picks).errors).toEqual([]);
    const byCard = new Map<string, number>();
    for (const p of picks) byCard.set(p.datacardId, (byCard.get(p.datacardId) ?? 0) + 1);
    expect(byCard.get('elucidian-starstrider.canid')).toBe(1);
    expect(byCard.get('elucidian-starstrider.voidsman')).toBe(4); // 3 with lasgun + 1 with rotor cannon
    expect(picks).toHaveLength(data.selection.totalOperatives);

    // Swapping any row for another copy of a different row is refused, naming the printed group.
    const canid = picks.find((p) => p.datacardId === 'elucidian-starstrider.canid')!;
    const swapped = picks.map((p) =>
      p.datacardId === 'elucidian-starstrider.voidmaster' ? { ...canid } : p,
    );
    const v = validateRosterFor(data, swapped);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('Every ELUCIDIAN STARSTRIDER operative');
  });

  it('HUNTER CLADE: "Other than GUNNER and WARRIOR operatives…" exempts a role keyword, prefix and all', () => {
    // hunter-clade is a later batch, so read the raw JSON rather than the module registry.
    const data = JSON.parse(readFileSync('data/teams/hunter-clade.json', 'utf8')) as TeamData;
    expect(data.selection.constraints).toContainEqual({ kind: 'uniqueExcept', roles: ['GUNNER', 'WARRIOR'] });
    // The printed rows keep their sub-group prefix, so exact-equality matching never fired and
    // the team could not field a legal kill team at all.
    const roles = data.selection.list.map((e) => e.role);
    expect(roles).toContain('RANGER WARRIOR');
    expect(roles).not.toContain('WARRIOR');
    expect(validateRosterFor(data, defaultRoster(data)).errors).toEqual([]);
  });

  it('HEARTHKYN SALVAGER: the WARRIOR exemption does NOT leak to JUMP PACK WARRIOR', () => {
    // The list prints a plain WARRIOR row BESIDE a JUMP PACK WARRIOR row, so the printed
    // exemption names the plain operative; the jump-pack one is a different operative and stays
    // unique. Hunter Clade is the opposite shape — no plain row at all — so there the keyword
    // fallback must fire. The rule that satisfies both: fall back to the keyword only when the
    // list prints no row of that exact name.
    const data = teamData('hearthkyn-salvager');
    const roles = data.selection.list.map((e) => e.role);
    expect(roles).toContain('WARRIOR');
    expect(roles).toContain('JUMP PACK WARRIOR');
    const picks = defaultRoster(data);
    expect(validateRosterFor(data, picks).errors).toEqual([]);
    const jump = picks.filter((p) => p.datacardId.endsWith('jump-pack-warrior'));
    expect(jump).toHaveLength(1);
    // A second one is refused as a repeat.
    const twice = validateRosterFor(data, [...picks, { ...jump[0]! }]);
    expect(twice.errors.join(' ')).toContain('only include each operative on this list once');
  });

  it('KASRKIN: the TROOPER exemption does NOT leak to RECON-TROOPER, VOX-TROOPER or DEMO-TROOPER', () => {
    // Token matching, deliberately not substring matching — those are different operatives.
    const data = teamData('kasrkin');
    const picks = defaultRoster(data);
    const recon = picks.find((p) => p.datacardId === 'kasrkin.recon-trooper');
    expect(recon).toBeDefined();
    const twice = validateRosterFor(data, [...picks, { ...recon! }]);
    expect(twice.errors.join(' ')).toContain('only include each operative on this list once');
  });

  it('VOID-DANCER TROUPE: "up to one fusion pistol" is enforced, and the default roster respects it', () => {
    const data = teamData('void-dancer-troupe');
    expect(data.selection.constraints).toContainEqual({ kind: 'maxItem', item: 'fusion pistol', max: 1 });
    const picks = defaultRoster(data);
    const v = validateRosterFor(data, picks);
    expect(v.errors).toEqual([]);
    const fusion = v.weapons.filter((ws) => ws.some((w) => w.toLowerCase() === 'fusion pistol'));
    expect(fusion.length).toBeLessThanOrEqual(1);
  });

  it('CORSAIR VOIDSCARRED: "your kill team cannot include both a blaster and a wraithcannon"', () => {
    const data = teamData('corsair-voidscarred');
    expect(data.selection.constraints).toContainEqual({
      kind: 'exclusiveItems',
      items: ['blaster', 'wraithcannon'],
    });
    expect(validateRosterFor(data, defaultRoster(data)).errors).toEqual([]);
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
