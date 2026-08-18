# Progress

Newest entry at the top. Each entry: date, phase, what landed, what is next.

## 2026-08-18 — Playability pass on the game UI (owner feedback)

**Landed this session (branch `claude/kill-team-ui-review-dilt11`)** — the owner's first
hands-on session surfaced four blockers; all fixed, plus the deeper issues found on review:

- **Tap-to-move.** Reposition/Dash/Fall Back/Charge (and Move With Barricade) previously
  dispatched with no path and were silently rejected — movement was impossible from the UI.
  They now arm a planner: a range ring appears, each board tap lays a waypoint, the path is
  validated live by the engine's own `check` (green/red, inches used, the rule that blocks
  it), and Confirm dispatches the exact validated intent. On a phone, arming auto-switches
  to the Board tab and the controls dock under the board (D-037).
- **Operatives have names.** `SelectRoster` derives a unique-within-team display name from
  each datacard ("Trooper C", "Sergeant"); every panel, button, prompt and log line uses it.
  Letters remain as the board-token glyph (D-036).
- **The rail follows the battle.** The killzone browser only exists before rosters lock
  (picking a map resets the battle); the Battle card's blind "Advance phase" is gone —
  setup, a new Strategy panel (roll-off → ready → alternating gambits, the first gambit UI),
  and an "End turning point" button that stays disabled while operatives are ready (D-038).
- **Saved kill teams first.** The team picker lists the player's saved rosters above the
  full team list instead of a collapsed footer.
- Also: deployment highlights the active drop zone and shows rejection reasons inline;
  Pick Up Marker resolves its marker instead of silently failing; Shoot/Fight team variants
  ("Shoot (Astartes)") are reachable through the target buttons; weapon profiles (frag/krak)
  are selectable; the battle log auto-scrolls; system log lines say "Player 1", not "p1".
- Coverage: `tests/names.test.ts` pins the naming rules; full suite (1314), e2e smoke and a
  scripted browser run through setup → deploy → strategy → firefight → tap-to-move all green.

**Next** — pass-and-play `viewer` gating for the action sheet, oval-base facing control in
the planner, and a way to aim unique actions that need a target operative.

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
