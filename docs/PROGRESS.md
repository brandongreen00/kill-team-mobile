# Progress

Newest entry at the top. Each entry: date, phase, what landed, what is next.

## 2026-08-23 — Rules review: you could walk through walls, and 18 doors were missing (D-064…D-066)

Owner report, with a screenshot: a Dash moved an operative straight through a Volkus stronghold
wall, and "the bottom layer of Volkus, particularly that stronghold, has a door that is
accessible terrain" — which the app did not model. Both were real, and they turned out to be
the same bug seen from two sides.

- **`validateMove` never checked the path.** It checked climb/drop/jump legality, budget,
  hazardous areas, control range and the FINAL base position — and, for a crossing, only parts
  typed `Wall`. Volkus walls are `Heavy`, so nothing stopped a straight line through them.
  Killzones: *"Operatives cannot move through terrain — they must move around, climb over or
  drop/jump off it."* Now `terrain.ts::pathBlockedByTerrain` runs per increment, exempting
  Accessible, Insignificant and Ceiling by their own printed precedence clauses, and exempting
  the feature an increment is climbing onto or dropping from (D-064, D-065).
- **Which meant path *generation* had to change too.** Both the AI and the board's move preview
  declared a single straight increment to the destination — only ever legal because nothing
  checked it. `reachableCells` now records each cell's parent, and `routePath` turns that back
  into the fewest increments that actually walk round the terrain. The AI still beats
  GreedyAgent 78% and RandomLegalAgent 96%, with zero rejected intents across the soak.
- **18 of 24 Volkus doorways were unmodelled holes.** `_volkus_doors` only ever resolved
  Stronghold B. Stronghold A (0/6) and both Large Ruins (0/12) shipped with the doorway as a
  gap in the wall ring: free to cross, no cover, obscuring nobody. Fixing the movement bug alone
  would have **sealed those buildings**, because Stronghold A's doorway is 1.17" and a 32mm base
  is 1.26" — it only fits because the door is Accessible terrain. `tools/maps/doors.py` recovers
  each door from the hole it leaves, validated by reproducing all six card-read Stronghold B
  doors exactly (D-066).

`tests/maps-volkus-doors.test.ts` walks the real shipped maps: through every one of the 24
doors, and into every wall.

**Also closed: 40 of 48 kill teams had no rules at all.** `src/ui/App.tsx` had registered
`BATCH_1` since phase 5 — carried forward through five more batches — so a battle with any of
the other 40 teams ran with no faction rules, no ploys, no faction equipment and no unique
actions, and said nothing, because `rebuildHooks` optional-chains a module it cannot find. The
modules were all written, imported and tested; the shell just never handed them to the context.
It now registers `ALL_TEAM_MODULES`, which costs **30 bytes** in the bundle: `src/teams/index.ts`
imports all 48 at the top, so the barrel was already shipping. `tests/wiring.test.ts` pins that
every team `data/teams/_index.json` offers has a module behind it.

## 2026-08-22 — Merging batch 6: three regressions a clean merge hid (D-061…D-063)

main's batch-6 work and this branch's UI overhaul merged with conflicts in two append-only docs
and a green test suite — and still shipped a kill team you could not field. The conflicts and
what they hid:

- **A decision-number collision.** Both sides had numbered from D-043 while the branch was open.
  Ours were renumbered to D-046…D-060 *before* the merge, so main's three rows dropped into the
  gap instead of six decisions sharing three ids.
- **One test that only fails merged.** `tests/teams/hunter-clade.test.ts` passes on main alone.
  D-052 made the end of a turning point an observable phase, so its two hard-coded
  `AdvancePhase` calls now stop one step short of Ready — where `readyStep` clears
  `gambitsUsedTP`. Both call sites now advance until the turning point has actually incremented
  rather than counting phase transitions.
- **Three regressions no test caught**, found by auditing the intersection of main's validator
  rewrite with this branch's roster UI (D-061…D-063). The worst: D-045 stopped handing an
  operative every alternative of a printed either/or, and the builder had no picker to replace
  it, so both Hunter Clade gunners resolved to an arc rifle — against a printed cap of one arc
  rifle. **A legal two-gunner Hunter Clade roster was unbuildable in the app.**

**Still open, and not caused by the merge** — `src/ui/App.tsx` registers only `BATCH_1`, so 40 of
48 teams play a whole battle with no faction rules, ploys or unique actions, silently
(`rebuildHooks` optional-chains a missing module). main's eight new modules are dead code in the
shipped app. Also unreached: per-team faction equipment (`ctx.equipment` holds only the 11
universal options) and tac-op archetype filtering (`state.teams[p].archetypes` is never
populated).

## 2026-08-22 — Phase 4 UI, second pass: the screens the game needed but could not reach (D-052…D-058)

Adversarial review of the first pass, driving the built app rather than reading it. Seven
screens or controls turned out to be dead code, unreachable state, or silently wrong. The
worst of them made the battle unplayable and had survived the first pass because the
screenshot script happened to expand the sheet by hand before every activation.

**Landed**

- **You can activate an operative again.** Two effects set the sheet's detent — the plan's own,
  and "a screen that arms the board must not be covered by its own sheet" — and the second ran
  last, so it won. `firefight.activate` arms the board AND asks for `half` ("tap one of your
  ringed operatives, **or pick it from the list below**"): forced to `rest`, that list rendered
  ~75px below the bottom of the screen. For four turning points the only way to activate
  anyone was to hit a 44px token on the board. One effect now, and the plan's detent wins.
- **The end of a turning point is a screen.** `advanceTurningPoint` set `phase = 'endOfTP'` and
  overwrote it with `'strategy'` a few lines later, so the phase never existed for a moment
  anything could observe and up to 6VP a side appeared in the top bar with no summary (D-052).
- **Equipment is set up on the killzone.** The step was in the types, the intent worked and the
  per-item constraints were complete — but nothing ever entered the step (D-053). Where an item
  may go is now sampled from `validateEquipmentPlacement` cell by cell, because the constraints
  are per item and mostly are not the drop zone (D-054).
- **"Allocate manually" does something.** Only the `auto` option carried data, so the manual
  button ran the automatic allocation on the screen that decides how much damage an operative
  takes (D-056). It is a screen now: incoming hits as chips, tap one to save against it.
- **Shooting is usable.** The target list was hidden at `rest` and the board was framed on the
  shooter alone, so "Pick a target" appeared over a board with no targets on it (D-059).
- **Pass-and-play secrecy works during the battle**, not just during setup (D-057).
- **One finger aims, one mouse pans** (D-055); the zoom cluster stops hopping corners (D-058).
- **The roster builder works on a phone held sideways.** At 390px of height the catalogue got
  ~70px — less than one row — so rows under the pinned tray were literally untappable. Status
  and tray move to a rail, as the battle screen already does.
- Smaller, all found in screenshots: the `half` detent clipped the first row on a 568px iPhone
  SE; the blocked-row reason and the roster's one piece of good news were both truncated
  mid-sentence; the log could not tell P1's "H" from P2's "H" (both teams letter A–I); setup
  entries were labelled "TP0".
- Tests: 2617 unit (9 for the allocator, including two exhaustive cross-checks against
  `allocateSavesOptimally` and three that render the screen; 3 for the equipment step) and 43
  Playwright across four viewports, one of which pins the detent rule that caused the worst
  of these. `docs/ui-review/` recaptured, now including the equipment,
  end-of-turning-point, mid-battle handover and battle-end screens.

**Next**

1. **Decide D-050** — eight dead `baseGap(...) < -1e-4` overlap guards remain.
2. A pre-battle screen: the app boots straight into a battle on the first killzone, and
   `state.critOpId` is unset, so no crit op scores.
3. Autosave/restore by replaying `Store.exportReplay()`'s intent log.
4. Move waypoints, and a screen-space dice dock.
5. A `frame: 'fit'` screen at the `half` detent shows its top letterbox bar and hides the
   bottom one behind the sheet; fixing it means telling the Board the sheet's *current* height,
   which is the coupling `--sheet-rest` exists to avoid.

## 2026-08-22 — Phase 4 UI: the phone experience, rebuilt (D-046…D-051)

The owner's verdict on the previous shell was "basically unusable", with three specific
complaints: selecting operatives moved things around under the thumb, placing an operative
meant switching from the Play tab to the Board tab by hand, and it generally did not feel like
a phone app. All three were real, and two of them were symptoms of the same thing: four tabs
with no shared idea of what the player was in the middle of.

**Landed**

- **No tab bar.** One stage with the killzone mounted once, and a command sheet over it.
  `commandPlan(state)` (`src/ui/command/`) derives exactly one screen from GameState, so there
  is no navigation state that can disagree with the game. Rosters, log and killzones are routes
  behind the menu. Three window classes: bottom sheet, side sheet (phone landscape), three
  columns (≥1200px). See `docs/UI.md`.
- **Deployment happens on the board.** It is already framed on the deploying player's drop
  zone, everything else masked out; the next operative is auto-armed; a drag shows a ghost of
  its real base tinted by `canDeployAt`; a refused tap surfaces the reducer's own sentence;
  Undo takes it back.
- **You can move.** `PerformAction` needs a `MovePath` and the old action sheet sent none, so
  every move was rejected — the app could not play a game. Moves are now aimed on the board
  against `reachableCells` / `moveBudget` / `validateMove`.
- **The roster builder does not move under the thumb.** Catalogue first and the only scroller,
  fixed chrome above and below it, fixed row geometry. Measured at 0px across five consecutive
  adds; `e2e/smoke.spec.ts` asserts |Δy| ≤ 1.
- **Equipment and tac ops have a screen.** `SelectTacOp` is the only caller of `ctx.initOps`,
  so before this no op initialised and a whole battle scored nothing.
- **Four new core selectors** — `canDeployAt`, `actionAvailability`, `deployToAct`,
  `gambitToAct` — so the UI reads rules instead of deriving them (D-049).
- **Contrast**: `--line` was 1.33:1 on `--surface-2` (every control border invisible), the two
  players' colours were 1.00:1 in luminance (identical in greyscale and to a red-green
  colour-blind player), and terrain was 1.17:1 on the board. All three fixed and verified.
- **One core bug**, surfaced by the placement work: `baseGap` clamps at zero, so the
  `baseGap(...) < -1e-4` overlap guard has never fired. Fixed in `DeployOperative`; eight
  further copies are documented, not changed (D-050).
- Tests: 2603 unit + 31 Playwright across four viewports (iPhone SE, Pixel 7, iPhone 13
  landscape, desktop). Screenshots of the whole flow in `docs/ui-review/`.

**Next**

1. **Decide D-050** — eight dead `baseGap(...) < -1e-4` overlap guards remain in `movement.ts`
   and seven team modules. Fixing them changes what is a legal move end position and fails
   sixteen rules tests whose fixtures place models at overlapping centres.
2. A pre-battle screen: the app boots straight into a battle on the first killzone, and
   `state.critOpId` is unset, so no crit op scores.
4. Autosave/restore by replaying `Store.exportReplay()`'s intent log (serialising GameState
   alone would rewind the RNG).
5. Move waypoints (a path around a corner currently costs two actions) and a screen-space dice
   dock (dice are sized in world inches, so they shrink with the zoom).
## 2026-08-22 — Phase 6 complete: all 48 kill teams (batches 2–6)

**Landed**
- **Every kill team in the game has a rule module.** Batches 2–6 added 40 teams to batch 1's 8:
  Astartes & Heretic Astartes, Imperium non-Astartes, Aeldari/Drukhari/Votann, Necron/Tyranid/
  T'au/Ork, and Chaos. Per-rule counts, every partial and every reminder-only clause with its
  engine reason, are in `docs/TEAM-STATUS.md` — 48 honest rows.
- **Every team fields a legal roster.** `tests/roster.test.tsx`'s `KNOWN_GAPS` map is deleted
  rather than emptied. Nine printed selection shapes that were silently unenforced or actively
  wrong now work: `sameAsAbove` folding, `every` as a fixed roster, keyword-scoped `maxCount`,
  `distinctOptions`, `maxItem` (incl. plural and role-scoped), `exclusiveItems`, the `uniqueExcept`
  keyword fallback in both directions, footnote membership, and `choiceGroups` (D-029, D-034..D-045).
- **Four engine seams**, all additive and all forced by a printed sentence: `onCounteract` emitted
  before the Engage-order test (D-028), `onSelectWeapon` emitted from the Shoot action's `check`
  with a `dryRun` flag (D-032), per-team rare weapon rule text (D-033), and a scraper fix for
  compound and weapon-qualified selection caps (D-043).
- **The soak ring rings six batches** — 48 pairings × 2 maps, 96 games, zero rejected intents.
- Suite: **3303 tests** across 62 files, up from 457 at the end of batch 1.

**Bugs this phase found in already-merged work**
- Angels of Death and Plague Marines shipped in batch 1 with an `onCounteract` handler that could
  never fire; Kasrkin's Concealed Position removed the Sharpshooter's whole rifle instead of the
  one restricted profile.
- Four teams were fielding the wrong weapons because `LoadoutOption` never modelled `choiceGroups`
  — reported as three separate per-team oddities across batches 3, 4 and 5 before the cause was
  found (D-045).
- The Deathwatch GRAVIS cap, the Blooded `^1` cap and the Elucidian fixed roster each accepted an
  illegal kill team.

**Next**
- `fight.ts` still emits no `onRollAttack` (D-031) — cited by teams in every batch and the highest
  value seam left. It needs all existing handlers audited for a `ctx.type` guard first.
- No end-of-move position hook: the single most-reported gap across all six batches.
- `tools/teams/normalise.py`: 8 data defects ranked by cost in `docs/TEAM-STATUS.md`
  § "What the six batches found in the data". The truncated effect lists block 6 rules outright.
- The bundle is 2,081 kB / 442 kB gzipped and is now the largest technical debt in the tree.
- A coverage-maximising roster for the soak (D-042): the printed default leaves whole rules
  untested for many teams.

## 2026-08-20 — Phase 1 maps: D-014 dashed-rectangle recall (D-039)

**Landed**
- `dashed_rects()` rewritten to recognise an outline by geometry rather than by a fixed count of
  dash segments, which missed every small dashed rectangle on every Volkus card and, through
  `split_blob_by_chips()`, corrupted the neighbouring piece as well. Details in
  `tools/maps/README.md` §5a and `docs/DECISIONS.md` D-039.
- `validate_maps.py` G7 gained a hard tier: below IoU **0.85** a feature fails the build. Genuine
  exceptions are allow-listed by `(mapId, label)` with a reason, and a stale entry is itself a
  failure.
- New tests: `tools/maps/test_extract.py` (detector, on synthetic cards drawn to the card
  conventions — the official cards are GW IP and not in the repo) and `tests/maps-rubble.test.ts`
  (every rubble piece is a 4-vertex rectangle at its template size, across all four killzones).
  Both are in CI; CI now installs the extractor's Python deps and runs `maps:test` + `maps:validate`.
- `docs/MAPS.md` §6 corrected: it previously explained these IoUs as "the visible part of an
  overlapped piece", which is not what was happening.

**Next**
1. **Re-run `pnpm maps:extract && pnpm maps:overlay && pnpm maps:validate` on a machine that has
   `docs/context-pack/`** and delete the `_D014` entries from `IOU_ALLOW` and `PENDING`. The data in
   `data/maps/volkus/**` is still the old, wrong geometry — the fix is in the tool, not yet in the
   output.
2. Stronghold B (IoU 0.57–0.79 on maps 1–3) — the only piece with two upper levels; unrelated to
   D-014 and still unexplained.
3. `bheta-decima-6` B/D (0.40/0.48) — a merged blob split wrongly; same shape as D-014, different
   cause (`bheta_features()` never calls `dashed_rects()`).
4. `data/terrain/volkus.json` → `footprints` stores one placed part instead of the union, so
   multi-part pieces (strongholds, small ruins) read at half their built extent.

---

## 2026-08-17 — Phases 0, 2 and 4 landed; 1, 3, 5 and 7 in flight

**Landed this session (branch `claude/kill-team-mobile-overhaul-ohtkmd`)**
- Phase 0 scaffold + the pure rules core (see the entry below for the file-by-file list).
- Phase 1 maps: `tools/maps/extract_cards.py` produces all 24 Approved Ops layouts into
  `data/maps/**` with terrain templates and heights in `data/terrain/**`, plus side-by-side
  overlays in `docs/maps/overlays/`.
- Phase 4 game flow + visible dice: world-anchored dice pools above the shooter and the
  defender, per-die identity through rerolls, one decision surface for every reactive window,
  the activation action sheet, the setup wizard, and the targeting-line inspector with a
  side-elevation view.
- Team data for all 48 kill teams (`tools/teams/*`, `data/teams/*.json`, `docs/TEAM-DATA.md`)
  including a diff against the old `factions.js` that found 3 missing teams, ~20 dropped rare
  weapon rules and 8 real stat errors.
- `tests/integration.test.ts` plays a deployment and a shot on all 24 real maps with zero
  rejected intents; `e2e/smoke.spec.ts` is green on iPhone SE, Pixel 7 and desktop.

**Still in flight at the end of the session** — ops (`src/core/ops/**`), universal equipment
(`src/core/equipment/**`), the AI (`src/ai/**`) and the batch-1 team modules
(`src/teams/**`). See `docs/OVERHAUL-REPORT.md` for exactly where each stands.

---

## 2026-08-17 — Phase 0 (scaffold) complete; Phase 2 (rules core) substantially implemented

**Done**
- Vite + TypeScript (strict, `noUncheckedIndexedAccess`) + Vitest + Preact scaffold. The old app
  moved unchanged to `public/legacy/` and still ships at `/kill-team-mobile/legacy/`.
- CI rewritten: typecheck → `no_math_random` lint → vitest → build, with a gate asserting both
  `dist/index.html` and `dist/legacy/index.html` exist.
- Core type contracts (`src/core/types.ts`): terrain 2.5D model, datacards, GameState,
  PendingDecision, markers, effects.
- `rng.ts` (mulberry32 + scripted + journalling), `geometry.ts` (base-to-base incl. ellipses,
  polygons, 3D segment-vs-prism), `terrain.ts` (index, surfaces, Ceiling, hazardous, wall routing
  via a visibility graph, wall corner zones), `visibility.ts` (head→silhouette visibility, targeting
  lines, cover, obscured, Vantage, smoke), `movement.ts` (climb/drop/jump/Accessible/Obstructing,
  legality with named reasons, 0.5" reachability field), `dice.ts` (dice identity, Lethal/Accurate/
  Severe/Rending/Punishing/obscured, optimal allocation incl. Brutal, Devastating),
  `weaponRules.ts` (all 23 universal rules parsed + rare-rule registry), `hooks.ts` (32 hook points,
  deterministic dispatch), `actions.ts` (Reposition/Dash/Fall Back/Charge/Pick Up/Place Marker/
  Shoot/Fight/Guard/Hatchway Fight/Operate Hatch/Breach), `sequences/shoot.ts` + `sequences/fight.ts`
  (resumable state machines with PendingDecisions), `phases.ts`, `decisions.ts`, `reducer.ts`.
- 19 passing tests including a deterministic end-to-end shot and a replay-equality test.

**Next**
1. Phase 1 maps — extraction of the 24 Approved Ops layouts (in flight).
2. Phase 3 ops — 9 crit ops, 12 tac ops, kill op, primary op, initiative cards.
3. Phase 4 — flow + visible dice UI.
4. Phase 5 — teams, batch 1 first.
5. Phase 7 — AI.
