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
  pickFor,
  supportProblems,
  usage,
  warningsFor,
  type RosterPickIn,
  type TeamData,
} from '../src/ui/roster/rules.ts';
import { exportRosters, importRosters, loadRosters, saveRoster, STORAGE_KEY } from '../src/ui/roster/storage.ts';
import { defaultRoster, entryId, validateRosterFor } from '../src/teams/selection.ts';
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
    // This list must only ever shrink. Deathwatch, Elucidian Starstrider, Gellerpox Infected
    // and Wolf Scouts were on it until the validator learned that a leader drawn from the
    // same list consumes one of the printed selections rather than sitting on top of them.
    // What is left is two genuine data problems, not validator arithmetic:
    //   battleclade         — the printed rule caps COMBAT SERVITOR per WEAPON ("up to one
    //                         with meltagun... up to three with incendine igniter"); the
    //                         scrape flattened it to two role-level maxCount rows, 1 and 3.
    //   inquisitorial-agent — its second group of 5 may be REQUISITIONED operatives defined
    //                         in a faction rule, which are not on the selection list.
    expect(flagged).toEqual(['battleclade', 'inquisitorial-agent']);
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

  it('will not let a rules gap pass silently: unsupported teams say so, and say so on the button', () => {
    // BATTLECLADE's printed rule caps COMBAT SERVITOR operatives per WEAPON ("up to one with
    // meltagun... up to three with incendine igniter"), but the scrape flattened that into two
    // role-level maxCount rows, 1 and 3. The stricter row makes the 8-operative group
    // unfillable, so the screen says so out loud and the confirm button admits that legality
    // is not being enforced for this team.
    //
    // DEATHWATCH used to be in this test. It is not a gap any more: its WATCH SERGEANT is
    // drawn from the same list as everyone else, and the validator now counts a list-drawn
    // leader toward the slots instead of on top of them.
    let confirmed: ConfirmedRoster | null = null;
    const team = JSON.parse(readFile('data/teams/battleclade.json')) as { name: string };
    act(() => {
      render(<RosterBuilder teams={[team as never]} onConfirm={(r) => (confirmed = r)} confirmLabel="Lock in" />, root);
    });
    click(byText('.team-list button', team.name));
    // The gap is stated on screen, quoting the group it cannot fill.
    expect(root.querySelector('.warn-block')?.textContent ?? '').toMatch(/cannot be filled/);

    // And it is a dead end, not an escape hatch: adding every offered operative still cannot
    // reach a legal roster, so confirm stays disabled rather than shipping an illegal team.
    const confirm = () => byText('button', 'Lock in') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    for (let i = 0; i < 24; i++) {
      const add = root.querySelector('button.add:not([disabled])');
      if (!add) break;
      click(add);
    }
    expect(confirm().disabled).toBe(true);
    expect(confirmed).toBeNull();
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
  // asserted here rather than left as a comment.
  const KNOWN_GAPS: Record<string, string> = {
    battleclade:
      'COMBAT SERVITOR parses two role-level maxCount rows (1 and 3); the printed rule caps them per WEAPON ("up to one with meltagun... up to three with incendine igniter"), so the stricter row makes the 8-operative group unfillable',
  };

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
