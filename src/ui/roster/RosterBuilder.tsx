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
import { useState } from 'preact/hooks';
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

  const team = teams.find((t) => t.id === teamId);
  const data = team ? asTeamData(team) : null;

  const load = (r: SavedRoster) => {
    setTeamId(r.teamId);
    setPicks(r.picks);
    setName(r.name);
  };

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
            {/* The player's own kill teams come first — they are what gets fielded most. */}
            {library.length > 0 && (
              <>
                <h2>Your kill teams</h2>
                <ul class="team-list saved-list">
                  {library.map((r) => (
                    <li key={r.id} class="row" style={{ flexWrap: 'nowrap' }}>
                      <button onClick={() => load(r)} style={{ flex: 1 }}>
                        <span class="team-name">{r.name}</span>
                        <span class="muted">
                          {teams.find((t) => t.id === r.teamId)?.name ?? r.teamId} · {r.picks.length} operatives
                        </span>
                      </button>
                      <button class="op-remove" aria-label={`Delete ${r.name}`} onClick={() => setLibrary(deleteRoster(r.id))}>
                        🗑
                      </button>
                    </li>
                  ))}
                </ul>
                <h2>All kill teams</h2>
              </>
            )}
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
                const d = asTeamData(t);
                const unsupported = d ? supportProblems(d).length > 0 : true;
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
          showList={false}
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
  const warnings = warningsFor(data);
  const problems = supportProblems(data);
  const expected = data.selection.totalOperatives || data.selection.slots + (data.selection.leader?.count ?? 1);
  /** The 6 teams whose printed list the shared validator provably cannot satisfy (see rules.ts). */
  const override = problems.length > 0 && blocking.length === 0 && picks.length === expected;
  const canConfirm = validation.ok || override;

  const setPick = (i: number, pick: RosterPickIn) => setPicks(picks.map((p, j) => (j === i ? pick : p)));

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
                  onClick={() => setPicks([...picks, pickFor(data, row.index)])}
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
  /** The team picker lists the saved kill teams itself, so its Library is import/export only. */
  showList?: boolean;
}

function Library({ library, teams, onLoad, onDelete, onImport, io, setIo, showList = true }: LibraryProps) {
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  return (
    <details class="roster-library" style={{ marginTop: 12 }}>
      <summary>{showList ? `Saved rosters (${library.length})` : 'Import / export rosters'}</summary>
      {library.length === 0 && <p class="muted">Saved rosters live in this browser, and survive a reload.</p>}
      {showList && (
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
      )}
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
