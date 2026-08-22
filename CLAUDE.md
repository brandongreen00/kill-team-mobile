# CLAUDE.md

Guidance for Claude Code sessions in this repository. **Read this in full before changing anything**,
then `docs/PROGRESS.md` (what is done / next) and `docs/DECISIONS.md` (every judgement call).

## Project

A phone-first **and** desktop-friendly digital tabletop for **Warhammer 40,000 Kill Team, 3rd edition
(KT24)** — current rules = Core Book June 2026 + Approved Ops 2025. Static build, deployed to GitHub
Pages. No server, no runtime network access: all rules/map/team data is bundled at build time.

The repository is mid-overhaul from a plain-JS app to TypeScript + Vite. The old app lives in
`public/legacy/` and ships at `/kill-team-mobile/legacy/` until the new app reaches setup → deploy →
shoot/fight → scoring parity; it is deleted in the final QA phase.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server |
| `pnpm build` | Production build into `dist/` (this is what Pages deploys) |
| `pnpm typecheck` | `tsc --noEmit`, strict |
| `pnpm test` | Vitest unit + acceptance tests |
| `pnpm lint:rng` | Fails if `Math.random` appears outside `src/core/rng.ts` |
| `pnpm e2e` | Playwright smoke on phone + desktop viewports |
| `pnpm maps:extract` | Re-extract `data/maps/**` from the official Approved Ops card PNGs |
| `pnpm maps:overlay` | Render extraction overlays into `docs/maps/overlays/` for visual review |
| `pnpm teams:scrape` / `pnpm teams:normalise` | Rebuild `data/teams/**` from Wahapedia (build-time only) |

CI (`.github/workflows/pr-check.yml`) runs typecheck → rng lint → tests → build, and asserts both
`dist/index.html` and `dist/legacy/index.html` exist.

## Non-negotiable architecture rules

1. **The rules core is pure.** Everything under `src/core/` is deterministic TypeScript with no DOM,
   React or I/O imports. It is the only code allowed to mutate game state, and only through validated
   **intents**: `reduce(state, intent, ctx)`. UI and AI drive it through the same channel. **Illegal
   intents are rejected into `state.rejected` + the log — never thrown.** Acceptance tests assert the
   rejected count is zero for AI-driven games.
2. **Seeded, injectable RNG.** `src/core/rng.ts`. A battle replays byte-identically from
   `(rosters, map, seed, intents[])`. `pnpm lint:rng` enforces it.
3. **Reactive windows are first class.** The reducer emits `PendingDecision { who, kind, options }`
   and blocks until an intent resolves it: rerolls (Ceaseless/Balanced/Relentless/Command Re-roll),
   cover-vs-obscured, defence allocation, strike-or-block, On Guard interrupts, firefight ploys.
   Never add a rule that assumes the active player does everything.
4. **Distances are inches, base-to-base.** `gap(a,b) = max(0, dist(centres) − r_a − r_b)`; ovals are
   modelled as ellipses with facing. Base sizes are stored in mm and converted once
   (`MM_PER_INCH = 25.4`). **Board origin is bottom-left, +y up**, x along the long edge — the y-flip
   happens exactly once, in `src/ui/Board.tsx`'s `worldTransform`.
5. **Rules as data + hooks.** The kernel knows no faction. Team rules, ploys, equipment, killzone
   rules and ops register typed handlers in `src/core/hooks.ts`. An unknown hook name is a build
   error (`assertHookName`); an unknown weapon rule is a data-lint failure
   (`assertKnownRules`). Never a silent no-op.
6. **Terrain is 2.5D.** Every terrain *part* is an extruded polygon `{ poly, z0, z1, types }`.
   Visibility, cover, obscured, climb/drop/jump, Vantage and Ceiling all read that one model.
7. **Everything the player sees derives from state.** No hidden mutable module variables.
8. **Tests are the spec.** Every rule test quotes the rule text it pins.

## Layout

```
src/core/       pure rules core — types, rng, geometry, terrain, visibility, movement, dice,
                weaponRules, actions, phases, reducer, decisions, hooks, context, init,
                sequences/{shoot,fight}.ts, ops/*, equipment/*
src/teams/      one module per kill team: rules/ploys/equipment/unique actions as hooks (+ tests)
src/ai/         legal-intent enumeration, evaluation, search
src/ui/         Preact app: App, Board (SVG), dice overlays, flow screens
data/           maps/, terrain/, teams/, ops/, equipment/ — generated, committed
tools/          maps/ (card extraction), teams/ (scrape+normalise), lint/
tests/          vitest;  e2e/  playwright
docs/           PROGRESS.md DECISIONS.md TEAM-STATUS.md RULES-COVERAGE.md MAPS.md UI.md AI.md
```

## How to…

**Add a kill team.** `data/teams/<slug>.json` (from `pnpm teams:scrape && pnpm teams:normalise`),
then `src/teams/<slug>/index.ts` exporting a `TeamModule` that registers faction rules, 4 strategy
ploys, 4 firefight ploys, 4 equipment options and unique actions as hooks, plus
`src/teams/<slug>/<slug>.test.ts` with one test per rule quoting its text. Update
`docs/TEAM-STATUS.md`. Rare weapon rules go through `registerRareWeaponRule`.

**Re-extract maps.** `pnpm maps:extract && pnpm maps:overlay`, then review
`docs/maps/overlays/*.png` against the source cards and update the QA table in `docs/MAPS.md`.
Terrain heights live in `data/terrain/<killzone>.json` with `provenance` + `confidence`; the engine
must never hard-code a height.

**Run an AI soak.** `pnpm soak` plays bot-vs-bot games across maps and asserts zero rejected intents
and no exceptions.

**Change the phone UI.** Read `docs/UI.md` first. The shell has no tab bar: `commandPlan(state)`
in `src/ui/command/` derives exactly one screen from GameState, and a new screen is a branch
there, never a new place to navigate to. The UI may read any non-mutating `(ctx, state, …)`
selector from `src/core/**` and may never re-implement one — if the answer is not exported, add
a named selector to the core in the same change (`canDeployAt`, `actionAvailability`,
`deployToAct`, `gambitToAct` are the four that exist for this reason). Re-capture
`docs/ui-review/` and look at it.

## Rules invariants worth remembering

- 4 turning points; Strategy phase (Initiative → Ready → Gambit) then Firefight phase.
- CP: 2 at Select Operatives, then 1/TP each, 2/TP for the player without initiative from TP2.
- APL changes clamp to ±1; Move can never be reduced below 4"; injured = −2" Move and Hit worsened 1.
- Control range = **visible to and within 1"**, mutual. Cover is denied within 2" of the shooter.
  Obscured ignores Heavy terrain within 1" of *either* operative.
- Counteract: expended Engage operative, one free 1AP action excluding Guard, ≤2" move, once per TP,
  and it is **not** an activation (so action restrictions do not apply).
- **Close Quarters (Condensed Environment, Guard/On Guard, Hatchway Fight) is gated to Gallowdark AND
  Tomb World** — `map.closeQuarters` (owner decision, `docs/DECISIONS.md` D-002). Do not make Guard
  universal.
- Objective markers are 40mm; all other markers 20mm.

## IP

Public repo, MIT licence on the code. Game data needed to run the app (stats, names, short rule text)
is vendored as the previous app did; **raw Wahapedia HTML and long verbatim rules dumps are
gitignored** (`docs/context-pack/`, `docs/rules-source/`). Personal, non-commercial use.
