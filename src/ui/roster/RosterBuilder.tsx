/**
 * The roster builder — Core Rules › SELECT OPERATIVES.
 *
 * Every kill team's printed selection requirements are structured data
 * (`data/teams/<slug>.json` › `selection`) and one shared validator reads them:
 * `validateRosterFor` in `src/teams/selection.ts`. This screen never re-implements a rule.
 * It offers the printed list, asks the validator after every change, quotes back the rule
 * behind each violation, and refuses to hand an illegal kill team to `SelectRoster`.
 *
 * Anything the validator cannot express (see docs/TEAM-DATA.md §5) is shown as a warning
 * rather than silently dropped.
 */
import { useEffect, useState } from 'preact/hooks';
import { validateRosterFor, withRequisitioned, type RosterPickIn } from '../../teams/selection.ts';
import { requisitionGroups } from '../../teams/data.ts';
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
import type { Datacard } from '../../core/types.ts';
import {
  deleteRoster,
  exportRosters,
  importRosters,
  loadRosters,
  saveRoster,
  type SavedRoster,
} from './storage.ts';

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
  /** Every datacard the roster can name, REQUISITIONED borrowings included. */
  datacards: Datacard[];
}

export interface RosterBuilderProps {
  /**
   * Every kill team, as little or as much of each as the caller has: an id/name/faction
   * summary is enough to draw the picker, and `loadTeam` fetches the chosen team's real JSON.
   */
  teams: TeamLike[];
  /** Fetches one kill team's full JSON on demand (`src/ui/data.ts`). */
  loadTeam?: (id: string) => Promise<TeamLike | null>;
  title?: string;
  confirmLabel?: string;
  /** Present when the builder is feeding a battle; absent when it is just a workbench. */
  onConfirm?: (roster: ConfirmedRoster) => void;
  onCancel?: () => void;
}

export function RosterBuilder({
  teams,
  loadTeam,
  title = 'Select operatives',
  confirmLabel,
  onConfirm,
  onCancel,
}: RosterBuilderProps) {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [picks, setPicks] = useState<RosterPickIn[]>([]);
  const [name, setName] = useState('');
  const [library, setLibrary] = useState<SavedRoster[]>(() => loadRosters());
  const [search, setSearch] = useState('');
  const [io, setIo] = useState<{ text: string; note?: string; error?: string }>({ text: '' });
  /** Full JSON fetched on demand: the chosen team, plus any kill team it borrows datacards from. */
  const [fetched, setFetched] = useState<Record<string, TeamLike>>({});

  const summary = teams.find((t) => t.id === teamId);
  const team = summary ?? (teamId ? fetched[teamId] : undefined);
  // The caller may hand over whole teams (tests, and any caller that already has them) or
  // just the picker summary; either way the full JSON is what the builder validates against.
  const base = asTeamData(summary) ?? asTeamData(teamId ? fetched[teamId] : undefined);
  // "…or REQUISITIONED operatives from one group in the Inquisitorial Requisition faction
  // rule" — those datacards are printed with the donor kill team, so its JSON is fetched too
  // and merged in (with the printed faction-keyword swap) before anything is validated.
  const donorIds = base
    ? [...new Set(requisitionGroups(base).map((g) => g.sourceTeam).filter((x): x is string => Boolean(x)))]
    : [];
  const donors = donorIds
    .map((id) => asTeamData(teams.find((t) => t.id === id)) ?? asTeamData(fetched[id]))
    .filter((d): d is TeamData => Boolean(d));
  const data = base ? withRequisitioned(base, donors) : null;
  const missingDonors = donorIds.filter((id) => !donors.some((d) => d.id === id));
  const wanted = [...(teamId && !base ? [teamId] : []), ...missingDonors].filter((id) => !fetched[id]);

  useEffect(() => {
    if (!loadTeam || wanted.length === 0) return;
    let live = true;
    void Promise.all(wanted.map(async (id) => [id, await loadTeam(id)] as const)).then((rows) => {
      if (!live) return;
      const add: Record<string, TeamLike> = {};
      for (const [id, t] of rows) if (t) add[id] = t;
      if (Object.keys(add).length > 0) setFetched((cur) => ({ ...cur, ...add }));
    });
    return () => {
      live = false;
    };
  }, [wanted.join(',')]);

  const load = (r: SavedRoster) => {
    setTeamId(r.teamId);
    setPicks(r.picks);
    setName(r.name);
  };

  // ---- the chosen team's JSON is still in flight ------------------------
  if (teamId && !data && wanted.length > 0) {
    return (
      <section class="card roster">
        <h2>{title}</h2>
        <p class="muted">Loading {team?.name ?? teamId}…</p>
      </section>
    );
  }

  // ---- team picker ------------------------------------------------------
  if (!team || !data) {
    const q = search.trim().toLowerCase();
    const list = teams
      .filter((t) => !q || `${t.name} ${t.faction ?? ''} ${(t.archetypes ?? []).join(' ')}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    return (
      <section class="card roster">
        <h2>{title}</h2>
        {teams.length === 0 ? (
          <p class="muted">
            No kill-team data found. Run <code>pnpm teams:scrape &amp;&amp; pnpm teams:normalise</code>.
          </p>
        ) : (
          <>
            <p class="muted">Choose a kill team, then select operatives as its printed requirements allow.</p>
            <input
              type="search"
              value={search}
              placeholder="Search kill teams"
              aria-label="Search kill teams"
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              style={{ width: '100%', marginBottom: 8 }}
            />
            <ul class="team-list">
              {list.map((t) => {
                // Only teams whose JSON is already here can be checked; the rest are
                // checked the moment they are picked (nothing is claimed either way).
                const d = asTeamData(t);
                const unsupported = d !== null && supportProblems(d).length > 0;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => {
                        setTeamId(t.id);
                        setPicks([]);
                        setName(`${t.name} kill team`);
                      }}
                    >
                      <span class="team-name">{t.name}</span>
                      <span class="muted">{t.faction}</span>
                      <span class="row">
                        {(t.archetypes ?? []).map((a) => (
                          <span key={a} class="tag">
                            {a}
                          </span>
                        ))}
                        {unsupported && (
                          <span class="tag warn-tag" title="This team's printed list needs rules the shared validator cannot express">
                            ⚠ rules gap
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <Library
          library={library}
          teams={teams}
          onLoad={load}
          onDelete={(id) => setLibrary(deleteRoster(id))}
          io={io}
          setIo={setIo}
          onImport={(text) => setLibrary(importRosters(text))}
        />
        {onCancel && (
          <div class="row" style={{ marginTop: 8 }}>
            <button onClick={onCancel}>Back</button>
          </div>
        )}
      </section>
    );
  }

  // ---- builder ----------------------------------------------------------
  const rows = entryRows(data);
  const validation = validateRosterFor(data, picks);
  const u = usage(data, picks);
  const blocking = blockingErrors(validation);
  const blockingNow = new Set(blocking);
  const warnings = warningsFor(data, missingDonors);
  const problems = supportProblems(data);
  const expected = data.selection.totalOperatives || data.selection.slots + (data.selection.leader?.count ?? 1);
  /**
   * The escape hatch for a team whose printed list the shared validator provably cannot
   * satisfy (see `supportProblems`). No kill team needs it today — it stays so a future data
   * gap surfaces as an explained override rather than an unbuildable screen.
   */
  const override = problems.length > 0 && blocking.length === 0 && picks.length === expected;
  const canConfirm = validation.ok || override;

  const setPick = (i: number, pick: RosterPickIn) => setPicks(picks.map((p, j) => (j === i ? pick : p)));
  const listProps = {
    data,
    picks,
    blockingNow,
    onAdd: (index: number) => setPicks([...picks, pickFor(data, index)]),
  };

  return (
    <section class="card roster">
      <div class="row">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <div class="spacer" />
        <button
          onClick={() => {
            setTeamId(null);
            setPicks([]);
          }}
        >
          Change kill team
        </button>
      </div>

      <div class="row" style={{ marginTop: 6 }}>
        <strong>{team.name}</strong>
        <span class="muted">{team.faction}</span>
        {(team.archetypes ?? []).map((a) => (
          <span key={a} class="tag">
            {a}
          </span>
        ))}
      </div>

      <Status usage={u} ok={validation.ok} />

      {(blocking.length > 0 || validation.errors.length > 0) && (
        <ul class="legality" aria-live="polite">
          {validation.errors.map((e, i) => (
            <li key={`${e}-${i}`} class={blockingNow.has(e) ? 'err' : 'todo'}>
              {blockingNow.has(e) ? '✖' : '•'} {e}
            </li>
          ))}
        </ul>
      )}
      {validation.ok && <p class="ok-line">✔ This kill team meets its printed selection requirements.</p>}

      {warnings.length > 0 && (
        <details class="warn-block">
          <summary>⚠ {warnings.length} rule{warnings.length === 1 ? '' : 's'} this app does not check</summary>
          <ul>
            {warnings.map((w, i) => (
              <li key={i} class="muted">
                {w.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details class="rules-block">
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

      <h2 style={{ marginTop: 12 }}>Your kill team ({picks.length})</h2>
      {picks.length === 0 && <p class="muted">Nothing selected yet — add operatives from the list below.</p>}
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

      <h2 style={{ marginTop: 12 }}>Selection list</h2>
      <EntryList rows={rows.filter((r) => !r.entry.requisitionGroup)} {...listProps} />

      {requisitionGroups(data).map((g) => {
        const groupRows = rows.filter((r) => r.entry.requisitionGroup === g.id);
        return (
          <details key={g.id} class="rules-block req-group">
            <summary>
              {data.selection.requisition!.keyword} — {g.name}
              {g.sourceTeam && !donors.some((d) => d.id === g.sourceTeam) ? ' (data not loaded)' : ''}
            </summary>
            <p class="muted">{g.rawText}</p>
            {(() => {
              // The requisition card prints its own size (DEATH KORPS says six) while the
              // kill team's list says how many selections this group is worth. They differ;
              // both are printed, so both are shown and the kill team's is the one counted.
              const slot = (data.selection.groups ?? []).find((x) => x.requisition);
              if (!slot || g.count === 0 || g.count === slot.count) return null;
              return (
                <p class="muted">
                  This card prints {g.count} operatives; this kill team's list allows {slot.count} selections here, and
                  that is the number counted.
                </p>
              );
            })()}
            {g.unresolved.length > 0 && <p class="muted">Not offered — no printed datacard: {g.unresolved.join(', ')}</p>}
            <EntryList rows={groupRows} {...listProps} />
            {Object.entries(g.footnotes).map(([marker, text]) => (
              <p key={marker} class="muted">
                <strong>{marker}</strong> {text}
              </p>
            ))}
          </details>
        );
      })}

      <div class="row" style={{ marginTop: 10 }}>
        <input
          value={name}
          aria-label="Roster name"
          placeholder="Roster name"
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <button
          onClick={() => setLibrary(saveRoster({ name: name.trim() || `${team.name} kill team`, teamId: team.id, picks }))}
        >
          💾 Save
        </button>
        <button onClick={() => setPicks([])}>Clear</button>
      </div>

      {onConfirm && (
        <div class="row" style={{ marginTop: 10 }}>
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
                // REQUISITIONED borrowings included, so the caller can register every
                // datacard the roster names without loading the donor teams itself.
                datacards: data.datacards,
              })
            }
          >
            {confirmLabel ?? 'Confirm kill team'}
            {override && !validation.ok ? ' (legality not enforced)' : ''}
          </button>
          {onCancel && <button onClick={onCancel}>Back</button>}
        </div>
      )}
      {onConfirm && !canConfirm && problems.length > 0 && (
        <p class="muted">
          This kill team cannot be completed here: {problems[0]}. Pick another kill team, or field it on the tabletop
          and report the gap.
        </p>
      )}
      {!onConfirm && onCancel && (
        <div class="row" style={{ marginTop: 10 }}>
          <button onClick={onCancel}>Back</button>
        </div>
      )}

      <Library
        library={library}
        teams={teams}
        onLoad={load}
        onDelete={(id) => setLibrary(deleteRoster(id))}
        io={io}
        setIo={setIo}
        onImport={(text) => setLibrary(importRosters(text))}
      />
    </section>
  );
}

interface EntryListProps {
  rows: ReturnType<typeof entryRows>;
  data: TeamData;
  picks: RosterPickIn[];
  blockingNow: Set<string>;
  onAdd: (index: number) => void;
}

/** The printed selection rows, each with the reason it cannot be taken when it cannot. */
function EntryList({ rows, data, picks, blockingNow, onAdd }: EntryListProps) {
  return (
    <ul class="entry-list">
      {rows.map((row) => {
        const can = addability(data, picks, row.index, blockingNow);
        const cost = costLabel(row.entry.selectionCost);
        return (
          <li key={row.id}>
            <div class="row">
              <button
                class="add"
                disabled={!can.ok}
                title={can.reason ?? `Add ${row.entry.role}`}
                aria-label={`Add ${row.entry.role}`}
                onClick={() => onAdd(row.index)}
              >
                ＋
              </button>
              <div class="entry-text">
                <div class="row">
                  <strong>{row.entry.role}</strong>
                  {row.entry.isLeader && <span class="tag">LEADER</span>}
                  {cost && <span class="tag">{cost}</span>}
                  {row.entry.footnoteGroup && <span class="tag">{row.entry.footnoteGroup}</span>}
                  {row.entry.requires.length > 0 && <span class="tag">needs {row.entry.requires.join(', ')}</span>}
                </div>
                <div class="muted">{row.entry.rawText}</div>
                {!can.ok && <div class="muted why">{can.reason}</div>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Status({ usage: u, ok }: { usage: ReturnType<typeof usage>; ok: boolean }) {
  return (
    <div class={`row roster-status${ok ? ' is-ok' : ''}`}>
      <span class="tag">
        {u.leader.used}/{u.leader.need} leader
      </span>
      <span class="tag">
        {u.slots.used}/{u.slots.total} selections
      </span>
      {u.total.max > 0 && (
        <span class="tag">
          {u.total.used}/{u.total.max} operatives
        </span>
      )}
      {u.groups.map((g) => (
        <span key={g.index} class="tag" title={g.rawText}>
          group {g.index}: {g.used}/{g.count}
        </span>
      ))}
    </div>
  );
}

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
    <details class="roster-library" style={{ marginTop: 12 }}>
      <summary>Saved rosters ({library.length})</summary>
      {library.length === 0 && <p class="muted">Saved rosters live in this browser, and survive a reload.</p>}
      <ul>
        {library.map((r) => (
          <li key={r.id} class="row">
            <button onClick={() => onLoad(r)}>
              {r.name} <span class="muted">· {teamName(r.teamId)} · {r.picks.length} operatives</span>
            </button>
            <button aria-label={`Delete ${r.name}`} onClick={() => onDelete(r.id)}>
              🗑
            </button>
          </li>
        ))}
      </ul>
      <div class="row">
        <button onClick={() => setIo({ text: exportRosters(library), note: 'Copy this JSON to keep or share the rosters.' })}>
          ⬇ Export JSON
        </button>
        <button
          onClick={() => {
            try {
              onImport(io.text);
              setIo({ text: '', note: 'Rosters imported.' });
            } catch (e) {
              setIo({ ...io, error: (e as Error).message });
            }
          }}
        >
          ⬆ Import JSON
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
  );
}
