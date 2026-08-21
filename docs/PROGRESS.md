# Progress

Newest entry at the top. Each entry: date, phase, what landed, what is next.

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
