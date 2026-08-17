/**
 * @vitest-environment jsdom
 *
 * The roster builder — Core Rules › SELECT OPERATIVES: "Select operatives for your kill team
 * as specified by its selection requirements."
 *
 * Legality is the shared, data-driven validator's job (`src/teams/selection.ts`); these tests
 * pin that the builder drives it honestly: each printed requirement is quoted back at the
 * player, a roster that breaks one can never be confirmed, and a roster that satisfies one
 * produces `RosterPick[]` the real reducer accepts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { RosterBuilder, type ConfirmedRoster } from '../src/ui/roster/RosterBuilder.tsx';
import {
  addability,
  asTeamData,
  blockingErrors,
  entryRows,
  isEitherEntry,
  loadoutModes,
  modeOfPick,
  pickFor,
  supportProblems,
  usage,
  warningsFor,
  withMode,
  type RosterPickIn,
  type TeamData,
} from '../src/ui/roster/rules.ts';
import { exportRosters, importRosters, loadRosters, saveRoster, STORAGE_KEY } from '../src/ui/roster/storage.ts';
import { defaultRoster, entryId, validateRosterFor, withRequisitioned } from '../src/teams/selection.ts';
import { requisitionGroups, selectionEntries } from '../src/teams/data.ts';
import { makeContext } from '../src/core/context.ts';
import { createBattle } from '../src/core/init.ts';
import { reduce } from '../src/core/reducer.ts';
import { SeededRng } from '../src/core/rng.ts';
import { testMap } from './fixtures.ts';
import kasrkinJson from '../data/teams/kasrkin.json';
import breacherJson from '../data/teams/imperial-navy-breacher.json';
import pathfindersJson from '../data/teams/pathfinders.json';

const kasrkin = kasrkinJson as unknown as TeamData;
const breachers = breacherJson as unknown as TeamData;
const pathfinders = pathfindersJson as unknown as TeamData;

/** A pick for the list row with this role (the nth row carrying it). */
function pickRole(data: TeamData, role: string, nth = 0): RosterPickIn {
  const rows = entryRows(data).filter((r) => r.entry.role === role);
  const row = rows[nth];
  if (!row) throw new Error(`no '${role}' row in ${data.id}`);
  return pickFor(data, row.index);
}

describe('roster builder — the shared validator decides, the screen quotes it', () => {
  it('rejects more operatives than the printed list allows, naming the requirement', () => {
    // "9 KASRKIN operatives selected from the following list:"
    const picks = [...defaultRoster(kasrkin), pickRole(kasrkin, 'TROOPER')];
    const v = validateRosterFor(kasrkin, picks);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('select exactly 9 further operatives');
    expect(usage(kasrkin, picks).slots.used).toBe(10);
    // …and the screen never offers the eleventh: the add button reports the full group.
    const trooper = entryRows(kasrkin).find((r) => r.entry.role === 'TROOPER')!;
    const can = addability(kasrkin, defaultRoster(kasrkin), trooper.index);
    expect(can.ok).toBe(false);
    expect(can.reason).toMatch(/no selections left|that group is full/);
  });

  it('rejects the same non-TROOPER operative twice — "can only include each operative on this list once"', () => {
    const picks = defaultRoster(kasrkin).filter((p) => p.datacardId !== 'kasrkin.trooper');
    const medic = picks.find((p) => p.datacardId === 'kasrkin.combat-medic')!;
    const v = validateRosterFor(kasrkin, [...picks, { ...medic }]);
    expect(blockingErrors(v).join(' ')).toContain('only include each operative on this list once');
    // The offending row is not addable once it is in the roster.
    const row = entryRows(kasrkin).find((r) => r.entry.datacardId === 'kasrkin.combat-medic')!;
    expect(addability(kasrkin, picks, row.index).ok).toBe(false);
  });

  it('rejects a C.A.T. UNIT with no SURVEYOR — "you can only select a C.A.T. UNIT … if it also includes a SURVEYOR"', () => {
    const leader = defaultRoster(breachers)[0]!;
    const cat = pickRole(breachers, 'C.A.T. UNIT');
    const v = validateRosterFor(breachers, [leader, cat]);
    const blocked = blockingErrors(v).join(' ');
    expect(blocked).toContain('C.A.T. UNIT');
    expect(blocked).toContain('SURVEYOR');
    const row = entryRows(breachers).find((r) => r.entry.role === 'C.A.T. UNIT')!;
    expect(addability(breachers, [leader], row.index)).toMatchObject({ ok: false });
    // With a SURVEYOR on the roster the same row becomes addable.
    const surveyor = pickRole(breachers, 'SURVEYOR');
    expect(addability(breachers, [leader, surveyor], row.index).ok).toBe(true);
  });

  it('rejects a footnote group breach — "You cannot select more than four of these operatives combined"', () => {
    const starred = entryRows(kasrkin).filter((r) => r.entry.footnoteGroup === '*');
    expect(starred.length).toBeGreaterThan(4);
    const picks = [defaultRoster(kasrkin)[0]!, ...starred.slice(0, 5).map((r) => pickFor(kasrkin, r.index))];
    const v = validateRosterFor(kasrkin, picks);
    expect(blockingErrors(v).join(' ')).toContain('four of these operatives combined');
    // The fifth starred row is refused by the screen.
    const four = [defaultRoster(kasrkin)[0]!, ...starred.slice(0, 4).map((r) => pickFor(kasrkin, r.index))];
    expect(addability(kasrkin, four, starred[4]!.index)).toMatchObject({ ok: false });
  });

  it('rejects a role maximum — "you cannot select more than 2 WEAPONS EXPERT operatives"', () => {
    const idx = entryRows(pathfinders).find((r) => r.entry.role === 'WEAPONS EXPERT')!.index;
    const picks = [defaultRoster(pathfinders)[0]!, pickFor(pathfinders, idx), pickFor(pathfinders, idx), pickFor(pathfinders, idx)];
    expect(blockingErrors(validateRosterFor(pathfinders, picks)).join(' ')).toMatch(/more than 2 WEAPONS EXPERT/);
  });

  it('a legal roster produces RosterPick[] the real reducer accepts', () => {
    const picks = defaultRoster(kasrkin);
    const v = validateRosterFor(kasrkin, picks);
    expect(v.ok).toBe(true);

    const ctx = makeContext({ rng: new SeededRng(1) });
    for (const card of kasrkin.datacards) ctx.datacards.set(card.id, card);
    const map = testMap();
    const state = createBattle(ctx, { map, seed: 1, mode: 'match' });
    const out = reduce(
      state,
      {
        t: 'SelectRoster',
        player: 'p1',
        teamId: kasrkin.id,
        operatives: picks.map((p, i) => ({ datacardId: p.datacardId, weapons: v.weapons[i] ?? [] })),
      },
      ctx,
    );
    expect(out.ok).toBe(true);
    expect(out.state.teams.p1.operativeIds).toHaveLength(picks.length);
    expect(out.state.rejected).toEqual([]);
    // Every operative resolved to a real datacard, leader included.
    const cards = out.state.teams.p1.operativeIds.map((id) => out.state.operatives[id]!.datacardId);
    expect(cards).toContain('kasrkin.sergeant');
  });

  it('every datacard weapon no option names is carried anyway, including Limited x', () => {
    // "the Navis Grenadier keeps its demolition charge (Limited 1)" — no choice to make.
    const row = entryRows(breachers).find((r) => r.entry.role === 'GRENADIER')!;
    expect(row.entry.alwaysWeapons).toEqual(expect.arrayContaining(['Demolition charge', 'Navis shotgun']));
  });

  it('surfaces the printed rules it cannot check instead of ignoring them', () => {
    // "Your kill team cannot include both a blaster and a wraithcannon" has no machine check.
    const corsair = asTeamData(
      JSON.parse(readFile('data/teams/corsair-voidscarred.json')) as { id: string; selection: unknown; datacards: unknown[] },
    )!;
    const texts = warningsFor(corsair).map((w) => w.text.toLowerCase());
    expect(texts.join(' ')).toContain('wraithcannon');
    expect(warningsFor(kasrkin)).toEqual([]);
  });

  it('flags exactly the teams whose printed list the shared validator cannot satisfy', () => {
    const flagged = teamFiles()
      .map((f) => asTeamData(JSON.parse(readFile(`data/teams/${f}`)) as never)!)
      .filter((d) => supportProblems(d).length > 0)
      .map((d) => d.id)
      .sort();
    // This list must only ever shrink, and it is now empty. Deathwatch, Elucidian
    // Starstrider, Gellerpox Infected and Wolf Scouts came off it when the validator learned
    // that a leader drawn from the same list consumes one of the printed selections rather
    // than sitting on top of them; battleclade came off when the pipeline learned to read a
    // weapon-qualified maximum ("up to one COMBAT SERVITOR operative with meltagun") as a cap
    // on the option rather than on the role; inquisitorial-agent came off when its second
    // group of 5 learned to draw from the list above and from the Inquisitorial Requisition
    // faction rule's groups.
    expect(flagged).toEqual([]);
  });

  it('caps a weapon-qualified maximum per WEAPON, not per role', () => {
    // BATTLECLADE: "Your kill team can only include up to one COMBAT SERVITOR operative with
    // meltagun, and it can only include up to three COMBAT SERVITOR operatives with incendine
    // igniter." Read as a role cap, the 8-operative group could never be filled.
    const bc = asTeamData(JSON.parse(readFile('data/teams/battleclade.json')) as never)!;
    const rows = entryRows(bc).filter((r) => r.entry.role === 'COMBAT SERVITOR');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const options = row.entry.loadouts;
    const withOption = (label: RegExp) => ({
      ...pickFor(bc, row.index),
      loadoutIds: [options.find((l) => label.test(l.label))!.id],
    });

    // Six COMBAT SERVITORs is legal — the role itself has no printed maximum.
    const legal = defaultRoster(bc);
    expect(validateRosterFor(bc, legal).ok).toBe(true);
    expect(legal.filter((p) => p.datacardId === row.entry.datacardId).length).toBeGreaterThan(3);

    // A second meltagun breaks the printed sentence, and the error quotes it.
    const twoMelta = [...defaultRoster(bc).slice(0, 4), withOption(/meltagun/i), withOption(/meltagun/i)];
    const v = validateRosterFor(bc, twoMelta);
    expect(blockingErrors(v).join(' ')).toContain('up to one COMBAT SERVITOR operative with meltagun');
    // …as does a fourth incendine igniter.
    const fourIgniter = [
      ...defaultRoster(bc).slice(0, 4),
      ...Array.from({ length: 4 }, () => withOption(/incendine igniter/i)),
    ];
    expect(blockingErrors(validateRosterFor(bc, fourIgniter)).join(' ')).toContain(
      'up to three COMBAT SERVITOR operatives with incendine igniter',
    );
  });

  it('an "…Or one option from each of the following" entry takes one whole mode, never both', () => {
    // The printed form is an either/or: "…with one of the following options: A; B. **Or** one
    // option from each of the following: (C or D) + (E or F)".
    const found: string[] = [];
    for (const f of teamFiles()) {
      const d = asTeamData(JSON.parse(readFile(`data/teams/${f}`)) as never)!;
      for (const row of entryRows(d)) {
        if (!isEitherEntry(row.entry)) continue;
        found.push(`${d.id}:${row.entry.role}`);
        const seed = pickFor(d, row.index);
        const options = withMode(row.entry, seed, 'options');
        const each = withMode(row.entry, seed, 'each');
        // The screen asks which mode first, and each mode is complete on its own.
        expect(loadoutModes(row.entry)).toHaveLength(2);
        expect(modeOfPick(row.entry, options)).toBe('options');
        expect(modeOfPick(row.entry, each)).toBe('each');
        expect(validateRosterFor(d, [options]).errors.join(' ')).not.toMatch(/not both|choose one of/);
        expect(validateRosterFor(d, [each]).errors.join(' ')).not.toMatch(/not both|choose one of/);
        // Taking a choice from both halves is exactly what the printed "Or" forbids.
        const both = { ...seed, loadoutIds: [...(options.loadoutIds ?? []), ...(each.loadoutIds ?? [])] };
        expect(validateRosterFor(d, [both]).errors.join(' ')).toContain('choose one of the two, not both');
      }
    }
    expect(found.sort()).toEqual([
      'angel-of-death:ASSAULT INTERCESSOR SERGEANT',
      'blades-of-khaine:DIRE AVENGER EXARCH',
      'death-korps:WATCHMASTER',
      'hunter-clade:SKITARII RANGER ALPHA',
      'hunter-clade:SKITARII VANGUARD ALPHA',
      'imperial-navy-breacher:SERGEANT-AT-ARMS',
      'murderwing:CHAOS LORD',
      'wyrmblade:NEOPHYTE LEADER',
    ]);
  });
});

describe('REQUISITIONED operatives — Inquisitorial Requisition', () => {
  const agents = () => asTeamData(JSON.parse(readFile('data/teams/inquisitorial-agent.json')) as never)!;
  const donor = (id: string) => asTeamData(JSON.parse(readFile(`data/teams/${id}.json`)) as never)!;
  const DONORS = ['death-korps', 'exaction-squad', 'imperial-navy-breacher', 'kasrkin'];
  const full = () => withRequisitioned(agents(), DONORS.map(donor));

  /** n picks from one REQUISITIONED group, in printed order. */
  function fromGroup(data: TeamData, groupId: string, n: number): RosterPickIn[] {
    const entries = selectionEntries(data);
    const out: RosterPickIn[] = [];
    for (let i = 0; i < entries.length && out.length < n; i++) {
      if (entries[i]!.requisitionGroup === groupId) out.push(pickFor(data, i));
    }
    return out;
  }

  it('offers exactly the six groups the faction rule names', () => {
    // "REQUISITIONED operatives can be taken from one of the following groups… DEATH KORPS,
    // EXACTION SQUAD, IMPERIAL NAVY BREACHER, KASRKIN, SISTER OF SILENCE, TEMPESTUS SCION"
    expect(requisitionGroups(agents()).map((g) => g.keyword)).toEqual([
      'DEATH KORPS',
      'EXACTION SQUAD',
      'IMPERIAL NAVY BREACHER',
      'KASRKIN',
      'SISTER OF SILENCE',
      'TEMPESTUS SCION',
    ]);
    // Every printed role resolved to a real datacard — nothing was invented to fill a gap.
    expect(requisitionGroups(agents()).flatMap((g) => g.unresolved)).toEqual([]);
  });

  it('fills the second group of five from one REQUISITIONED group', () => {
    // "5 INQUISITORIAL AGENT operatives selected from the list above, or REQUISITIONED
    // operatives from one group in the Inquisitorial Requisition faction rule"
    const data = full();
    const base = defaultRoster(agents()).slice(0, 7); // leader + TOME-SKULL + the first five
    const picks = [...base, ...fromGroup(data, 'death-korps', 5)];
    const v = validateRosterFor(data, picks);
    expect(v.ok, v.errors.join(' | ')).toBe(true);
    // The borrowed datacards really are the donor's, with the printed keyword swap applied.
    const trooper = data.datacards.find((c) => c.id === 'death-korps.trooper')!;
    expect(trooper.keywords).toContain('INQUISITORIAL AGENT');
    expect(trooper.keywords).not.toContain('DEATH KORPS');
    expect(v.weapons[7]!.length).toBeGreaterThan(0);
  });

  it('refuses REQUISITIONED operatives from two different groups', () => {
    // "(you cannot select REQUISITIONED operatives from different groups)"
    const data = full();
    const base = defaultRoster(agents()).slice(0, 7);
    const picks = [...base, ...fromGroup(data, 'kasrkin', 3), ...fromGroup(data, 'tempestus-scion', 2)];
    const blocked = blockingErrors(validateRosterFor(data, picks)).join(' ');
    expect(blocked).toContain('cannot select REQUISITIONED operatives from different groups');
    expect(blocked).toContain('Kasrkin and Tempestus Scion');
  });

  it("enforces each group's own printed list rules", () => {
    // KASRKIN group: "* You cannot select more than two of these operatives combined."
    const data = full();
    const base = defaultRoster(agents()).slice(0, 7);
    const starred = selectionEntries(data)
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e.requisitionGroup === 'kasrkin' && x.e.footnoteGroup === '*');
    expect(starred.length).toBeGreaterThan(2);
    const picks = [...base, ...starred.slice(0, 3).map((x) => pickFor(data, x.i))];
    expect(blockingErrors(validateRosterFor(data, picks)).join(' ')).toContain(
      'more than two of these operatives combined',
    );
  });

  it('says so instead of inventing an operative when the donor kill team is not loaded', () => {
    const data = agents(); // no donors merged in
    const picks = [...defaultRoster(data).slice(0, 7), ...fromGroup(data, 'kasrkin', 5)];
    const blocked = blockingErrors(validateRosterFor(data, picks)).join(' ');
    expect(blocked).toContain('printed with the Kasrkin kill team and is not loaded here');
  });

  it('relaxes uniqueness only when no REQUISITIONED operative is taken', () => {
    // "Your kill team can only include each operative on this list once, unless you're not
    // including any REQUISITIONED operatives, in which case you can include up to two GUN
    // SERVITOR operatives, but each one must have different options."
    const data = full();
    const gun = entryRows(data).find((r) => r.entry.role === 'GUN SERVITOR' && !r.entry.requisitionGroup)!;
    const opt = (n: number) => ({ ...pickFor(data, gun.index), loadoutIds: [gun.entry.loadouts[n]!.id] });

    // The default roster takes the relaxation: two GUN SERVITORs, different options, no
    // REQUISITIONED operative anywhere.
    const legal = defaultRoster(data);
    expect(validateRosterFor(data, legal).ok).toBe(true);
    expect(legal.filter((p) => p.datacardId === gun.entry.datacardId)).toHaveLength(2);
    expect(legal.some((p) => selectionEntries(data)[0]!.requisitionGroup)).toBe(false);

    // Two with the SAME option is refused…
    const same = [...legal.filter((p) => p.datacardId !== gun.entry.datacardId), opt(0), opt(0)];
    expect(blockingErrors(validateRosterFor(data, same)).join(' ')).toContain('must have different options');
    // …and so is a third, however they are equipped.
    const three = [...legal.filter((p) => p.datacardId !== gun.entry.datacardId).slice(0, 7), opt(0), opt(1), opt(2)];
    expect(blockingErrors(validateRosterFor(data, three)).join(' ')).toContain('GUN SERVITOR selected 3 times');
  });
});

describe('roster storage', () => {
  beforeEach(() => localStorage.removeItem(STORAGE_KEY));

  it('saves, reloads and round-trips through export/import', () => {
    const picks = defaultRoster(kasrkin);
    saveRoster({ name: 'Cadian Eight', teamId: 'kasrkin', picks });
    expect(loadRosters()).toHaveLength(1);
    const json = exportRosters(loadRosters());
    localStorage.removeItem(STORAGE_KEY);
    expect(loadRosters()).toEqual([]);
    const back = importRosters(json);
    expect(back[0]!.name).toBe('Cadian Eight');
    expect(back[0]!.picks).toHaveLength(picks.length);
    expect(validateRosterFor(kasrkin, back[0]!.picks).ok).toBe(true);
  });

  it('refuses rubbish with a readable message', () => {
    expect(() => importRosters('not json')).toThrow(/valid JSON/);
    expect(() => importRosters('{"rosters":[]}')).toThrow(/no usable rosters/);
  });
});

describe('roster builder (rendered)', () => {
  let root: HTMLDivElement;
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  const click = (el: Element | null | undefined) => {
    if (!el) throw new Error('no such control');
    act(() => {
      (el as HTMLElement).click();
    });
  };
  const byText = (selector: string, text: string | RegExp) =>
    [...root.querySelectorAll(selector)].find((e) =>
      typeof text === 'string' ? (e.textContent ?? '').includes(text) : text.test(e.textContent ?? ''),
    );

  it('builds a legal Kasrkin kill team through the UI and confirms it', () => {
    let confirmed: ConfirmedRoster | null = null;
    act(() => {
      render(
        <RosterBuilder teams={[kasrkinJson as never]} onConfirm={(r) => (confirmed = r)} confirmLabel="Lock in" />,
        root,
      );
    });

    // 1. the team picker, then the printed requirements and an empty, illegal roster.
    click(byText('.team-list button', 'Kasrkin'));
    expect(root.textContent).toContain('Printed selection requirements');
    const confirm = () => byText('button', 'Lock in') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    expect(root.querySelector('.legality')?.textContent).toMatch(/must include exactly 1 SERGEANT/);

    // 2. fill it by taking whatever the screen still offers — it only offers legal rows.
    for (let i = 0; i < 40 && confirm().disabled; i++) {
      const add = root.querySelector('button.add:not([disabled])');
      if (!add) break;
      click(add);
    }

    // 3. a full, legal kill team: 1 SERGEANT + 9 others, and the confirm button opens up.
    expect(root.querySelector('.ok-line')?.textContent).toContain('meets its printed selection requirements');
    expect(confirm().disabled).toBe(false);
    click(confirm());
    expect(confirmed).not.toBeNull();
    const out = confirmed as unknown as ConfirmedRoster;
    expect(out.teamId).toBe('kasrkin');
    expect(out.picks).toHaveLength(10);
    expect(validateRosterFor(kasrkin, out.picks).ok).toBe(true);
    // The leader's chosen option decides its weapons; the rest of its datacard does not ride along.
    const sergeant = out.picks.findIndex((p) => p.datacardId === 'kasrkin.sergeant');
    expect(out.weapons[sergeant]!.length).toBeGreaterThan(0);
    expect(out.weapons[sergeant]!.length).toBeLessThan(kasrkin.datacards.find((c) => c.id === 'kasrkin.sergeant')!.weapons.length);
  });

  it('shows always-carried weapons as carried, not as a choice', () => {
    act(() => {
      render(<RosterBuilder teams={[breacherJson as never]} />, root);
    });
    click(byText('.team-list button', 'Imperial Navy Breacher'));
    const row = entryRows(breachers).find((r) => r.entry.role === 'GRENADIER')!;
    const add = [...root.querySelectorAll('button.add')].find(
      (b) => b.getAttribute('aria-label') === `Add ${row.entry.role}`,
    );
    click(add);
    const card = root.querySelector('.op-card');
    expect(card?.textContent).toContain('Demolition charge');
    expect(card?.querySelector('.op-weapons .tag')?.textContent).toContain('always carried');
  });

  it('builds BATTLECLADE, whose COMBAT SERVITOR maximums are per weapon', () => {
    // This test used to assert the opposite: that BATTLECLADE was a dead end because the
    // scrape had flattened "up to one COMBAT SERVITOR operative with meltagun… up to three
    // with incendine igniter" into two role-level maximums (1 and 3), the stricter of which
    // made the printed 8-operative group unfillable. The pipeline now records the weapon
    // qualifier, so the team builds — deliberately changed, not weakened.
    let confirmed: ConfirmedRoster | null = null;
    const team = JSON.parse(readFile('data/teams/battleclade.json')) as { name: string };
    act(() => {
      render(<RosterBuilder teams={[team as never]} onConfirm={(r) => (confirmed = r)} confirmLabel="Lock in" />, root);
    });
    click(byText('.team-list button', team.name));
    expect(root.querySelector('.warn-block')?.textContent ?? '').not.toMatch(/cannot be filled/);

    const confirm = () => byText('button', 'Lock in') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    for (let i = 0; i < 24 && confirm().disabled; i++) {
      const add = root.querySelector('button.add:not([disabled])');
      if (!add) break;
      click(add);
    }
    expect(root.querySelector('.ok-line')?.textContent).toContain('meets its printed selection requirements');
    expect(confirm().disabled).toBe(false);
    click(confirm());
    expect(confirmed).not.toBeNull();
    // Never more than the printed number of any one option.
    const out = confirmed as unknown as ConfirmedRoster;
    const carrying = (w: string) => out.weapons.filter((ws) => ws.some((x) => x.toLowerCase() === w)).length;
    expect(carrying('meltagun')).toBeLessThanOrEqual(1);
    expect(carrying('incendine igniter')).toBeLessThanOrEqual(3);
  });

  it('builds INQUISITORIAL AGENT, whose second group of five draws from the list above', () => {
    // "5 INQUISITORIAL AGENT operatives selected from the list above, or REQUISITIONED
    // operatives from one group in the Inquisitorial Requisition faction rule." Taking the
    // list above means the group-3 rows have to stay addable past group 3's own five, which
    // is what `groupUsage`'s spill does — pinned here through the real screen.
    let confirmed: ConfirmedRoster | null = null;
    const all = ['inquisitorial-agent', 'death-korps', 'exaction-squad', 'imperial-navy-breacher', 'kasrkin'].map(
      (id) => JSON.parse(readFile(`data/teams/${id}.json`)) as never,
    );
    act(() => {
      render(<RosterBuilder teams={all} onConfirm={(r) => (confirmed = r)} confirmLabel="Lock in" />, root);
    });
    click(byText('.team-list button', 'Inquisitorial Agent'));
    const confirm = () => byText('button', 'Lock in') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    for (let i = 0; i < 40 && confirm().disabled; i++) {
      const add = root.querySelector('button.add:not([disabled])');
      if (!add) break;
      click(add);
    }
    expect(root.querySelector('.ok-line')?.textContent).toContain('meets its printed selection requirements');
    expect(confirm().disabled).toBe(false);
    click(confirm());
    const out = confirmed as unknown as ConfirmedRoster;
    expect(out.picks).toHaveLength(12);
    // Both printed groups of five are full, not one group of ten.
    expect(root.textContent).toContain('group 3: 5/5');
    expect(root.textContent).toContain('group 4: 5/5');
  });

  it('fetches a kill team on demand, and the donors its faction rule borrows from', async () => {
    // The picker only has name/faction rows (`loadTeamIndex`); the JSON arrives when a team
    // is chosen, and INQUISITORIAL AGENT also needs the four kill teams whose datacards its
    // Inquisitorial Requisition groups point at.
    const asked: string[] = [];
    const loadTeam = async (id: string) => {
      asked.push(id);
      return JSON.parse(readFile(`data/teams/${id}.json`)) as never;
    };
    const summaries = [
      { id: 'inquisitorial-agent', name: 'Inquisitorial Agent', faction: 'Imperium' },
      { id: 'kasrkin', name: 'Kasrkin', faction: 'Astra Militarum' },
    ];
    await act(async () => {
      render(<RosterBuilder teams={summaries as never} loadTeam={loadTeam} />, root);
    });
    // Nothing is fetched to draw the picker.
    expect(asked).toEqual([]);
    await act(async () => {
      click(byText('.team-list button', 'Inquisitorial Agent'));
    });
    // One flush for the team's own JSON, another for the donors its faction rule names.
    for (let i = 0; i < 4; i++) await act(async () => void (await Promise.resolve()));
    expect(asked).toContain('inquisitorial-agent');
    expect(asked).toEqual(expect.arrayContaining(['death-korps', 'exaction-squad', 'imperial-navy-breacher', 'kasrkin']));
    expect(root.textContent).toContain('Printed selection requirements');
    expect(root.textContent).toContain('REQUISITIONED — Kasrkin');
    expect(root.querySelector('.warn-block')?.textContent ?? '').not.toMatch(/not loaded/);
  });
});

// --- tiny fs helpers (the builder itself never reads the disk) --------------
function readFile(path: string): string {
  return readFileSync(path, 'utf8');
}
function teamFiles(): string[] {
  return readdirSync('data/teams').filter((f) => f.endsWith('.json') && !f.startsWith('_'));
}

describe('every kill team can be fielded', () => {
  const slugs = readdirSync('data/teams')
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace('.json', ''));

  it('has all 48 teams on disk', () => {
    expect(slugs).toHaveLength(48);
  });

  // A team whose printed rules the shared validator cannot express is surfaced in the UI as
  // a rules gap. That list must only shrink, and every entry needs a reason — so it is
  // asserted here rather than left as a comment. **It is now empty**: battleclade's
  // weapon-qualified COMBAT SERVITOR maximums and inquisitorial-agent's REQUISITIONED group
  // are both read from the printed text now. A gap added here must fail this test once fixed.
  const KNOWN_GAPS: Record<string, string> = {};

  for (const slug of slugs) {
    it(`${slug}: defaultRoster produces a legal kill team`, () => {
      const data = JSON.parse(readFileSync(`data/teams/${slug}.json`, 'utf8')) as TeamData;
      const picks = defaultRoster(data);
      const v = validateRosterFor(data, picks);
      if (KNOWN_GAPS[slug]) {
        // Documented gap: assert it still fails, so fixing it fails this test and forces the
        // entry to be removed rather than quietly left behind.
        expect(v.ok, `${slug} now validates — remove it from KNOWN_GAPS`).toBe(false);
        return;
      }
      expect(v.ok, `${slug}: ${v.errors.join(' | ')}`).toBe(true);
      expect(picks.length).toBeGreaterThan(0);
    });
  }
});
