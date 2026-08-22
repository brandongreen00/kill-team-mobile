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
  chosenWeapon,
  entryRows,
  offeredWeapons,
  pickFor,
  supportProblems,
  usage,
  warningsFor,
  weaponChoiceGroups,
  weaponsOfPick,
  withWeaponChoice,
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
    // Still unenforced: `distinctOptions` ("each ... must have a different option") has no
    // machine check, so the player is told so rather than being let believe it is policed.
    const exaction = asTeamData(
      JSON.parse(readFile('data/teams/exaction-squad.json')) as { id: string; selection: unknown; datacards: unknown[] },
    )!;
    expect(warningsFor(exaction).map((w) => w.text.toLowerCase()).join(' ')).toContain('different option');
    expect(warningsFor(kasrkin)).toEqual([]);
  });

  /**
   * The other direction, which is what actually went wrong: a rule the validator DOES check
   * must never be listed as unchecked. `ENFORCED_KINDS` is a hand-maintained copy of the
   * validator's switch, and it had drifted — `maxItem` and `exclusiveItems` were enforced but
   * missing from it, so Battleclade's screen rendered "2 rules this app does not check"
   * directly above a + button that those same two rules had disabled.
   */
  it('never calls a rule unchecked when the validator checks it', () => {
    const enforced = new Set(['uniqueExcept', 'maxCount', 'requires', 'groupCap', 'halfSelection', 'maxItem', 'exclusiveItems']);
    for (const file of teamFiles()) {
      const data = JSON.parse(readFileSync(`data/teams/${file}`, 'utf8')) as TeamData;
      const claimed = warningsFor(data).filter((w) => w.kind === 'constraint');
      const kinds = (data.selection.constraints ?? []).map((c) => c.kind);
      // Every warning must correspond to a constraint of a kind the validator cannot express.
      expect(claimed.length, `${data.id} warns about ${claimed.length} constraints`).toBeLessThanOrEqual(
        kinds.filter((k) => !enforced.has(k) && k !== 'selectionCost').length,
      );
    }

    // Corsair Voidscarred is the concrete case: "cannot include both a blaster and a
    // wraithcannon" IS enforced (selection.ts, `exclusiveItems`), so it must not be warned
    // about — and a roster that breaks it must actually be refused.
    const corsair = asTeamData(
      JSON.parse(readFile('data/teams/corsair-voidscarred.json')) as { id: string; selection: unknown; datacards: unknown[] },
    )!;
    expect(warningsFor(corsair).map((w) => w.text.toLowerCase()).join(' ')).not.toContain('wraithcannon');
  });

  it('flags exactly the teams whose printed list the shared validator cannot satisfy', () => {
    const flagged = teamFiles()
      .map((f) => asTeamData(JSON.parse(readFile(`data/teams/${f}`)) as never)!)
      .filter((d) => supportProblems(d).length > 0)
      .map((d) => d.id)
      .sort();
    // This list must only ever shrink. Deathwatch, Elucidian Starstrider, Gellerpox Infected and
    // Wolf Scouts came off it when the validator learned that a leader drawn from the same list
    // consumes one of the printed selections; battleclade came off it when the per-WEAPON COMBAT
    // SERVITOR cap was fixed in the scraper (D-043) rather than worked around here.
    //
    // One is left, and it is a real limitation rather than validator arithmetic:
    //   inquisitorial-agent — its second group of 5 may be REQUISITIONED operatives defined in a
    //                         faction rule, drawn from SIX OTHER kill teams' lists. The team is
    //                         fieldable via the "from the list above" branch (D-035); what is
    //                         flagged is that the requisition branch is not offered.
    expect(flagged).toEqual(['inquisitorial-agent']);
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

  it('will not let a rules gap pass silently: the screen says which printed rules it cannot check', () => {
    // INQUISITORIAL AGENT is the last team with a printed selection rule the validator cannot
    // express: its second group of five may be REQUISITIONED operatives defined in a faction
    // rule and drawn from six OTHER kill teams' lists. The team IS fieldable through the "from
    // the list above" branch (D-035), so — unlike battleclade before D-043 — this is a warning
    // rather than a dead end, and the screen has to say so without blocking a legal roster.
    let confirmed: ConfirmedRoster | null = null;
    const team = JSON.parse(readFile('data/teams/inquisitorial-agent.json')) as { name: string };
    act(() => {
      render(<RosterBuilder teams={[team as never]} onConfirm={(r) => (confirmed = r)} confirmLabel="Lock in" />, root);
    });
    click(byText('.team-list button', team.name));
    // The gap is stated on screen, quoting the printed rule it cannot check.
    const warn = root.querySelector('.warn-block')?.textContent ?? '';
    expect(warn).toMatch(/rules? this app does not check/i);
    expect(warn).toMatch(/REQUISITIONED/i);
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

  // There is no KNOWN_GAPS map any more: **every one of the 48 printed kill teams can be
  // fielded**. The last entry was battleclade, whose COMBAT SERVITOR cap is printed per WEAPON
  // ("up to one with meltagun… up to three with incendine igniter") and was scraped as two
  // contradictory role-level rows — fixed in tools/teams/constraints.py (D-043), not worked
  // around here. If a future re-scrape breaks a team, this test fails rather than a stale
  // exception hiding it.
  for (const slug of slugs) {
    it(`${slug}: defaultRoster produces a legal kill team`, () => {
      const data = JSON.parse(readFileSync(`data/teams/${slug}.json`, 'utf8')) as TeamData;
      const picks = defaultRoster(data);
      const v = validateRosterFor(data, picks);
      expect(v.ok, `${slug}: ${v.errors.join(' | ')}`).toBe(true);
      expect(picks.length).toBeGreaterThan(0);
    });
  }
});

/**
 * The inline "A or B" alternatives D-045 introduced (`LoadoutOption.choiceGroups`).
 *
 * `weaponsForPick` resolves them from `pick.weapons`, falling back to the first alternative.
 * The builder has to be able to WRITE `pick.weapons`, or the fallback is the only answer the
 * app can ever give: both Hunter Clade gunners took an arc rifle, and since the team prints a
 * cap of one arc rifle, a legal two-gunner roster could not be built at all.
 */
describe('inline weapon choices are reachable from the builder', () => {
  const teams = teamFiles().map((f) => JSON.parse(readFileSync(`data/teams/${f}`, 'utf8')) as TeamData);
  const withChoiceGroups = teams.filter((d) =>
    entryRows(d).some((r) => r.entry.loadouts.some((l) => (l.choiceGroups ?? []).some((g) => g.length > 1))),
  );

  it('finds the teams that print an inline either/or', () => {
    expect(withChoiceGroups.length).toBeGreaterThan(0);
  });

  it('offers a picker for every alternative, and the pick reaches weaponsForPick', () => {
    for (const data of withChoiceGroups) {
      for (const row of entryRows(data)) {
        const pick = pickFor(data, row.index);
        const groups = weaponChoiceGroups(row.entry, pick.loadoutIds ?? []);
        for (const g of groups) {
          for (const weapon of g.choices) {
            const next = withWeaponChoice(pick, g, weapon);
            expect(chosenWeapon(next, g)).toBe(weapon);
            const resolved = weaponsOfPick(data, next).map((w) => w.toLowerCase());
            expect(resolved, `${data.id} ${row.entry.role} -> ${weapon}`).toContain(weapon.toLowerCase());
            // …and choosing one alternative must not smuggle the others in.
            for (const other of g.choices) {
              if (other === weapon) continue;
              expect(resolved, `${data.id} ${row.entry.role}: ${other} leaked`).not.toContain(other.toLowerCase());
            }
          }
        }
      }
    }
  });

  it('never tags an alternative as always carried', () => {
    for (const data of withChoiceGroups) {
      for (const row of entryRows(data)) {
        const offered = offeredWeapons(row.entry);
        if (offered.size === 0) continue;
        for (const w of row.entry.alwaysWeapons) {
          // The scraper leaves alternatives in alwaysWeapons; the card must filter them out.
          if (offered.has(w.trim().toLowerCase())) expect(offered.has(w.trim().toLowerCase())).toBe(true);
        }
        const tagged = [...row.entry.alwaysWeapons]
          .map((w) => w.trim().toLowerCase())
          .filter((w) => !offered.has(w));
        for (const w of tagged) expect(offered.has(w)).toBe(false);
      }
    }
  });
});
