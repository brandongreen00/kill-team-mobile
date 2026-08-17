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
    expect(flagged).toEqual([
      'battleclade',
      'deathwatch',
      'elucidian-starstrider',
      'gellerpox-infected',
      'inquisitorial-agent',
      'wolf-scouts',
    ]);
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
    // DEATHWATCH picks its WATCH SERGEANT out of the same list as everyone else, which the
    // shared validator's slot arithmetic cannot express — so the screen says so out loud and
    // the confirm button admits that legality is not being enforced for this team.
    let confirmed: ConfirmedRoster | null = null;
    const deathwatch = JSON.parse(readFile('data/teams/deathwatch.json')) as { name: string };
    act(() => {
      render(<RosterBuilder teams={[deathwatch as never]} onConfirm={(r) => (confirmed = r)} confirmLabel="Lock in" />, root);
    });
    click(byText('.team-list button', deathwatch.name));
    expect(root.querySelector('.warn-block')?.textContent).toMatch(/no roster can satisfy both/);

    const confirm = () => byText('button', 'Lock in') as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    for (let i = 0; i < 20; i++) {
      const add = root.querySelector('button.add:not([disabled])');
      if (!add) break;
      click(add);
    }
    expect(confirm().disabled).toBe(false);
    expect(confirm().textContent).toContain('legality not enforced');
    click(confirm());
    expect((confirmed as unknown as ConfirmedRoster).picks).toHaveLength(5);
  });
});

// --- tiny fs helpers (the builder itself never reads the disk) --------------
function readFile(path: string): string {
  return readFileSync(path, 'utf8');
}
function teamFiles(): string[] {
  return readdirSync('data/teams').filter((f) => f.endsWith('.json') && !f.startsWith('_'));
}
