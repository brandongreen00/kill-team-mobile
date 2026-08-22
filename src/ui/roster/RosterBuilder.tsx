/**
 * The roster builder — Core Rules › SELECT OPERATIVES.
 *
 * Every kill team's printed selection requirements are structured data
 * (`data/teams/<slug>.json` › `selection`) and one shared validator reads them:
 * `validateRosterFor` in `src/teams/selection.ts`. This screen never re-implements a rule.
 * It offers the printed list, asks the validator after every change, quotes back the rule
 * behind each violation, and refuses to hand an illegal kill team to `SelectRoster`.
 *
 * WHY IT IS LAID OUT THIS WAY. The owner's report was "selecting operatives moves things
 * around weirdly", and it was exactly right. The old screen put the growing list of picked
 * operatives, a growing list of validation errors and a sticky status bar ABOVE the
 * catalogue, so every tap on a `+` grew the page above the thumb and slid the next row out
 * from under it; and every row that became unaddable sprouted a red two-line reason, which
 * changed that row's height too. Three separate reflows per tap.
 *
 * So, in order down the screen and never rearranged:
 *
 *   status  pinned, fixed height — the counts and one line of "what is still missing"
 *   body    the ONLY scroller: the catalogue first, then everything that changes size
 *   tray    pinned, fixed height — what you have picked, and the confirm button
 *
 * Nothing above the catalogue ever changes size, and a catalogue row's height is fixed by
 * its grid: the count badge and the add button live in a constant-width column, and the
 * reason a row is unavailable is one truncated line that is always rendered. Tap the `+`
 * fifty times and the row under your thumb does not move.
 */
import { useRef, useState } from 'preact/hooks';
import { validateRosterFor, type RosterPickIn } from '../../teams/selection.ts';
import { OperativeCard, costLabel } from './OperativeCard.tsx';
import {
  addability,
  asTeamData,
  blockingErrors,
  entryRows,
  pickFor,
  rowFor,
  supportProblems,
  usage,
  warningsFor,
  type TeamData,
} from './rules.ts';
import {
  deleteRoster,
  exportRosters,
  importRosters,
  loadRosters,
  saveRoster,
  type SavedRoster,
} from './storage.ts';
import { IconAlert, IconCheck, IconPlus, IconSave, IconSearch, IconTrash } from '../icons.tsx';

export interface TeamLike {
  id: string;
  name: string;
  faction?: string;
  archetypes?: string[];
  selection?: unknown;
  datacards?: unknown;
}

export interface ConfirmedRoster {
  teamId: string;
  picks: RosterPickIn[];
  /** Resolved weapon names per pick, in pick order (selection option + always-carried). */
  weapons: string[][];
  name: string;
}

export interface RosterBuilderProps {
  teams: TeamLike[];
  title?: string;
  confirmLabel?: string;
  /** Present when the builder is feeding a battle; absent when it is just a workbench. */
  onConfirm?: (roster: ConfirmedRoster) => void;
  onCancel?: () => void;
}

export function RosterBuilder({ teams, title = 'Select operatives', confirmLabel, onConfirm, onCancel }: RosterBuilderProps) {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [picks, setPicks] = useState<RosterPickIn[]>([]);
  const [name, setName] = useState('');
  const [library, setLibrary] = useState<SavedRoster[]>(() => loadRosters());
  const [search, setSearch] = useState('');
  const [io, setIo] = useState<{ text: string; note?: string; error?: string }>({ text: '' });
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const team = teams.find((t) => t.id === teamId);
  const data = team ? asTeamData(team) : null;

  const load = (r: SavedRoster) => {
    setTeamId(r.teamId);
    setPicks(r.picks);
    setName(r.name);
  };

  // ---- team picker ------------------------------------------------------
  if (!team || !data) {
    return (
      <TeamPicker
        teams={teams}
        title={title}
        search={search}
        setSearch={setSearch}
        onPick={(t) => {
          setTeamId(t.id);
          setPicks([]);
          setName(`${t.name} kill team`);
        }}
        library={library}
        onLoad={load}
        onDelete={(id) => setLibrary(deleteRoster(id))}
        io={io}
        setIo={setIo}
        onImport={(text) => setLibrary(importRosters(text))}
        onCancel={onCancel}
      />
    );
  }

  // ---- builder ----------------------------------------------------------
  const rows = entryRows(data);
  const validation = validateRosterFor(data, picks);
  const u = usage(data, picks);
  const blocking = blockingErrors(validation);
  const blockingNow = new Set(blocking);
  const warnings = warningsFor(data);
  const problems = supportProblems(data);
  const expected = data.selection.totalOperatives || data.selection.slots + (data.selection.leader?.count ?? 1);
  /** The teams whose printed list the shared validator provably cannot satisfy (see rules.ts). */
  const override = problems.length > 0 && blocking.length === 0 && picks.length === expected;
  const canConfirm = validation.ok || override;

  const setPick = (i: number, pick: RosterPickIn) => setPicks(picks.map((p, j) => (j === i ? pick : p)));
  /** How many of this catalogue row are already in the kill team. */
  const takenCount = countByRow(data, picks);

  /** The single line of "what is still missing", so the pinned bar never changes height. */
  const summary = validation.ok
    ? 'This kill team meets its printed selection requirements.'
    : (blocking[0] ?? validation.errors[0] ?? 'Keep selecting operatives.');

  const scrollToPicks = () => {
    const el = bodyRef.current?.querySelector('#your-kill-team');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <section class="builder roster">
      {/* PINNED. Fixed height: five chips and one line, whatever the roster is. */}
      <div class={`builder-status${validation.ok ? ' is-ok' : ''}`}>
        <div class="row" style={{ gap: 6, width: '100%' }}>
          <strong style={{ fontSize: 'var(--t-sm)' }}>{team.name}</strong>
          <div class="spacer" />
          <button
            class="ghost"
            style={{ minHeight: 32, padding: '0 8px', fontSize: 'var(--t-sm)' }}
            onClick={() => {
              setTeamId(null);
              setPicks([]);
            }}
          >
            Change
          </button>
        </div>
        <div class="row" style={{ gap: 6 }}>
          <span class={`tag${u.leader.used === u.leader.need ? ' is-ok' : ''}`}>
            {u.leader.used}/{u.leader.need} leader
          </span>
          <span class={`tag${u.slots.used === u.slots.total ? ' is-ok' : ''}`}>
            {u.slots.used}/{u.slots.total} selections
          </span>
          {u.total.max > 0 && (
            <span class={`tag${u.total.used === u.total.max ? ' is-ok' : ''}`}>
              {u.total.used}/{u.total.max} operatives
            </span>
          )}
          {u.groups.map((g) => (
            <span key={g.index} class={`tag${g.used === g.count ? ' is-ok' : ''}`} title={g.rawText}>
              group {g.index}: {g.used}/{g.count}
            </span>
          ))}
        </div>
        <p
          class={validation.ok ? 'ok-line' : 'muted'}
          aria-live="polite"
          style={{ margin: 0, width: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {validation.ok ? <IconCheck size={16} /> : null}
          {summary}
        </p>
      </div>

      {/* THE ONLY SCROLLER. The catalogue is first, so nothing that grows is above it. */}
      <div class="overlay-body" ref={bodyRef}>
        <p class="section-title">Selection list</p>
        <ul class="catalogue">
          {rows.map((row) => {
            const can = addability(data, picks, row.index, blockingNow);
            const cost = costLabel(row.entry.selectionCost);
            const taken = takenCount.get(row.index) ?? 0;
            // Fixed geometry: name, one truncated meta line, then a constant-width column.
            const meta = [
              row.entry.isLeader ? 'Leader' : null,
              cost,
              row.entry.requires.length > 0 ? `needs ${row.entry.requires.join(', ')}` : null,
              can.ok ? null : can.reason,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={row.id}>
                <div class={`entry${can.ok ? '' : ' is-blocked'}`}>
                  <div class="entry-main">
                    <div class="entry-name">{titleCase(row.entry.role)}</div>
                    <div class="entry-meta" title={meta || undefined}>
                      {meta || ' '}
                    </div>
                  </div>
                  <div class="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <span class="entry-count" style={{ visibility: taken > 0 ? 'visible' : 'hidden' }} aria-hidden={taken === 0}>
                      {taken}
                    </span>
                    <button
                      class="add entry-add"
                      disabled={!can.ok}
                      title={can.reason ?? `Add ${row.entry.role}`}
                      aria-label={`Add ${row.entry.role}`}
                      onClick={() => setPicks([...picks, pickFor(data, row.index)])}
                    >
                      <IconPlus size={22} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {/* Everything below here may change size freely: it is under the catalogue. */}
        {(blocking.length > 0 || validation.errors.length > 0) && (
          <ul class="legality" aria-live="polite">
            {validation.errors.map((e, i) => (
              <li key={`${e}-${i}`} class={blockingNow.has(e) ? 'err' : 'todo'}>
                {blockingNow.has(e) ? '✖' : '•'} {e}
              </li>
            ))}
          </ul>
        )}

        <h2 id="your-kill-team" class="section-title" style={{ marginTop: 20 }}>
          Your kill team ({picks.length})
        </h2>
        {picks.length === 0 && <p class="dim">Nothing selected yet — add operatives from the list above.</p>}
        {picks.map((pick, i) => {
          const row = rowFor(data, pick);
          if (!row) return null;
          return (
            <OperativeCard
              key={`${pick.entryId}-${i}`}
              data={data}
              row={row}
              pick={pick}
              onChange={(p) => setPick(i, p)}
              onRemove={() => setPicks(picks.filter((_, j) => j !== i))}
            />
          );
        })}

        {warnings.length > 0 && (
          <details class="warn-block disclosure">
            <summary>
              <IconAlert size={16} /> {warnings.length} rule{warnings.length === 1 ? '' : 's'} this app does not check
            </summary>
            <ul>
              {warnings.map((w, i) => (
                <li key={i} class="muted">
                  {w.text}
                </li>
              ))}
            </ul>
          </details>
        )}

        <details class="rules-block disclosure">
          <summary>Printed selection requirements</summary>
          <pre>{data.selection.rawText}</pre>
          {Object.entries(data.selection.footnotes ?? {}).map(([marker, text]) => (
            <p key={marker} class="muted">
              <strong>{marker}</strong> {text}
            </p>
          ))}
          {(data.selection.designerNotes ?? []).map((n, i) => (
            <p key={i} class="muted">
              <em>Designer's note.</em> {n}
            </p>
          ))}
        </details>

        <div class="row" style={{ marginTop: 12 }}>
          <input
            value={name}
            aria-label="Roster name"
            placeholder="Roster name"
            style={{ flex: 1, minWidth: 0 }}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <button
            class="quiet"
            onClick={() => setLibrary(saveRoster({ name: name.trim() || `${team.name} kill team`, teamId: team.id, picks }))}
          >
            <IconSave size={20} /> Save
          </button>
          <button class="quiet" onClick={() => setPicks([])}>
            Clear
          </button>
        </div>

        <Library
          library={library}
          teams={teams}
          onLoad={load}
          onDelete={(id) => setLibrary(deleteRoster(id))}
          io={io}
          setIo={setIo}
          onImport={(text) => setLibrary(importRosters(text))}
        />

        {onConfirm && !canConfirm && problems.length > 0 && (
          <p class="muted">
            This kill team cannot be completed here: {problems[0]}. Pick another kill team, or field it on the tabletop
            and report the gap.
          </p>
        )}
      </div>

      {/* PINNED. One horizontally-scrolling row plus the confirm button: constant height. */}
      <div class="overlay-foot">
        <div class="op-strip" aria-label="Selected operatives">
          {picks.length === 0 && <span class="dim">No operatives selected yet</span>}
          {picks.map((pick, i) => {
            const row = rowFor(data, pick);
            return (
              <button key={`${pick.entryId}-tray-${i}`} class="op-chip" onClick={scrollToPicks}>
                <span class="letter">{String.fromCharCode(65 + i)}</span>
                <span>
                  <span class="op-name">{titleCase(row?.entry.role ?? '?')}</span>
                  <span class="op-sub">edit</span>
                </span>
              </button>
            );
          })}
        </div>
        <div class={onCancel && onConfirm ? 'actions two-up' : 'actions'}>
          {onConfirm && (
            <button
              class="primary"
              disabled={!canConfirm}
              title={canConfirm ? undefined : (problems[0] ?? 'Fix the violations above first')}
              onClick={() =>
                onConfirm({
                  teamId: team.id,
                  picks,
                  weapons: validation.weapons,
                  name: name.trim() || `${team.name} kill team`,
                })
              }
            >
              {confirmLabel ?? 'Confirm kill team'}
              {override && !validation.ok ? ' (legality not enforced)' : ''}
            </button>
          )}
          {onCancel && (
            <button class="quiet" onClick={onCancel}>
              Back
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * How many picks sit on each catalogue row. Deliberately a plain function rather than a
 * `useMemo`: it is computed after the team-picker early return, and a hook below a
 * conditional return is a hooks-order bug waiting to happen.
 */
function countByRow(data: TeamData, picks: RosterPickIn[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const p of picks) {
    const row = rowFor(data, p);
    if (row) counts.set(row.index, (counts.get(row.index) ?? 0) + 1);
  }
  return counts;
}

/** ALL-CAPS role names are how the cards print them; on a phone they are a wall. */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bC\.a\.t\./gi, 'C.A.T.');
}

/* ------------------------------------------------------------ team picker */

interface TeamPickerProps {
  teams: TeamLike[];
  title: string;
  search: string;
  setSearch: (s: string) => void;
  onPick: (t: TeamLike) => void;
  library: SavedRoster[];
  onLoad: (r: SavedRoster) => void;
  onDelete: (id: string) => void;
  io: { text: string; note?: string; error?: string };
  setIo: (io: { text: string; note?: string; error?: string }) => void;
  onImport: (text: string) => void;
  onCancel?: (() => void) | undefined;
}

function TeamPicker({ teams, title, search, setSearch, onPick, library, onLoad, onDelete, io, setIo, onImport, onCancel }: TeamPickerProps) {
  const q = search.trim().toLowerCase();
  const list = teams
    .filter((t) => !q || `${t.name} ${t.faction ?? ''} ${(t.archetypes ?? []).join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => (a.faction ?? '').localeCompare(b.faction ?? '') || a.name.localeCompare(b.name));

  // Grouped by faction: 40-odd teams in one flat list is a scroll, not a choice.
  const groups: { faction: string; teams: TeamLike[] }[] = [];
  for (const t of list) {
    const faction = t.faction ?? 'Other';
    const last = groups[groups.length - 1];
    if (last && last.faction === faction) last.teams.push(t);
    else groups.push({ faction, teams: [t] });
  }

  return (
    <section class="builder roster">
      <div class="builder-status">
        <label class="row" style={{ width: '100%', gap: 8 }}>
          <IconSearch size={20} title="Search kill teams" />
          <input
            type="search"
            value={search}
            placeholder="Search kill teams"
            aria-label="Search kill teams"
            style={{ flex: 1, minWidth: 0 }}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      <div class="overlay-body">
        {teams.length === 0 ? (
          <p class="muted">
            No kill-team data found. Run <code>pnpm teams:scrape &amp;&amp; pnpm teams:normalise</code>.
          </p>
        ) : (
          <>
            <p class="dim" style={{ marginTop: 0 }}>
              {title}. Choose a kill team, then select operatives as its printed requirements allow.
            </p>
            {groups.map((g) => (
              <div key={g.faction} style={{ marginBottom: 16 }}>
                <p class="section-title">{g.faction}</p>
                <ul class="team-list">
                  {g.teams.map((t) => {
                    const d = asTeamData(t);
                    const unsupported = d ? supportProblems(d).length > 0 : true;
                    return (
                      <li key={t.id}>
                        <button onClick={() => onPick(t)}>
                          <span style={{ minWidth: 0 }}>
                            <span class="team-name">{t.name}</span>
                            <span class="team-sub" style={{ display: 'block' }}>
                              {(t.archetypes ?? []).join(' · ') || t.faction}
                            </span>
                          </span>
                          {unsupported && (
                            <span
                              class="tag is-warn"
                              title="This team's printed list needs rules the shared validator cannot express"
                            >
                              rules gap
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </>
        )}
        <Library library={library} teams={teams} onLoad={onLoad} onDelete={onDelete} io={io} setIo={setIo} onImport={onImport} />
      </div>
      {onCancel && (
        <div class="overlay-foot">
          <button class="quiet" onClick={onCancel}>
            Back
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- library */

interface LibraryProps {
  library: SavedRoster[];
  teams: TeamLike[];
  onLoad: (r: SavedRoster) => void;
  onDelete: (id: string) => void;
  onImport: (text: string) => void;
  io: { text: string; note?: string; error?: string };
  setIo: (io: { text: string; note?: string; error?: string }) => void;
}

function Library({ library, teams, onLoad, onDelete, onImport, io, setIo }: LibraryProps) {
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  return (
    <details class="roster-library disclosure" style={{ marginTop: 16 }}>
      <summary>Saved rosters ({library.length})</summary>
      {library.length === 0 && <p class="dim">Saved rosters live in this browser, and survive a reload.</p>}
      <ul class="team-list">
        {library.map((r) => (
          <li key={r.id} class="row" style={{ flexWrap: 'nowrap' }}>
            <button style={{ flex: 1, minWidth: 0 }} onClick={() => onLoad(r)}>
              <span style={{ minWidth: 0 }}>
                <span class="team-name">{r.name}</span>
                <span class="team-sub" style={{ display: 'block' }}>
                  {teamName(r.teamId)} · {r.picks.length} operatives
                </span>
              </span>
            </button>
            <button class="icon-only quiet" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r.id)}>
              <IconTrash size={20} />
            </button>
          </li>
        ))}
      </ul>
      <details class="disclosure">
        <summary>Import / export</summary>
        <div class="actions two-up">
          <button
            class="quiet"
            onClick={() => setIo({ text: exportRosters(library), note: 'Copy this JSON to keep or share the rosters.' })}
          >
            Export JSON
          </button>
          <button
            class="quiet"
            onClick={() => {
              try {
                onImport(io.text);
                setIo({ text: '', note: 'Rosters imported.' });
              } catch (e) {
                setIo({ ...io, error: (e as Error).message });
              }
            }}
          >
            Import JSON
          </button>
        </div>
        <textarea
          class="roster-io"
          aria-label="Roster JSON"
          rows={6}
          value={io.text}
          placeholder='{"format":"kill-team-mobile/rosters@1","rosters":[…]}'
          onInput={(e) => setIo({ text: (e.target as HTMLTextAreaElement).value })}
        />
        {io.note && <p class="muted">{io.note}</p>}
        {io.error && <p class="err">{io.error}</p>}
      </details>
    </details>
  );
}
