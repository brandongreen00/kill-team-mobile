# Progress

Newest entry at the top. Each entry: date, phase, what landed, what is next.

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
