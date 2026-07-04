# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A static, client-only web app for playing Warhammer 40K Kill Team on a phone. Pure HTML/CSS/JS — no framework, no bundler, no package manager. The repo IS the deployable site: `.github/workflows/deploy-pages.yml` uploads the repo root to GitHub Pages on every push to `main`.

## Commands

There is no build, install, or test runner. To work on the app:

- **Run locally**: open `index.html` in a browser, or serve the repo root with any static server (e.g. `python3 -m http.server`). Opening `game.html` directly via `file://` works but `sessionStorage` is unavailable in some headless contexts — `game.js` already falls back to the default `tomb-1` map in that case.
- **Lint / CI check**: `.github/workflows/pr-check.yml` runs `node --check` on every tracked `*.js` file and verifies tracked `*.html` files are non-empty. Reproduce locally with `for f in $(git ls-files '*.js'); do node --check "$f" || echo "FAIL $f"; done`. That is the entire test suite.
- **Deploy**: automatic on push to `main`. There is no staging.

## Architecture

### Page → script topology

Each HTML page is a screen. They share `styles.css` and load only the JS they need; load order matters because everything communicates through two browser globals, `window.KT` (board/map data) and `window.KT_RULES` (rules math):

| Page | Scripts (in order) | Role |
| --- | --- | --- |
| `index.html` | — | Main menu, links only |
| `maps.html` | `maps-data.js` | Pick a battlefield, writes `sessionStorage['kt.mapId']` |
| `map-creator.html` | `maps-data.js`, `map-creator.js` | Canvas-based editor; saves custom maps to `localStorage['kt.customMaps']` via `KT.saveCustomMap` |
| `roster.html` | `factions.js`, `presets.js` (inline script) | Build kill teams; saves to `localStorage['kt.rosters.v1']`; faction cards offer one-tap preset loadouts |
| `game.html` | `factions.js`, `presets.js`, `tacops.js`, `maps-data.js`, `rules.js`, `game.js`, `ai.js` | The actual game runtime (incl. solo mode vs the AI) |

`game.js` reads the chosen map from `sessionStorage['kt.mapId']` and the rosters players pick from `localStorage['kt.rosters.v1']`. There is no server, no API, no auth — all state is per-browser.

### Module responsibilities

- **`factions.js`** — `window.FACTIONS` array. **Vendored from `brandongreen00/ballistica-imperialis` (`src/data/factions.js`)**, sourced from wahapedia.ru/kill-team3. Treat it as data, not code: prefer pulling updates from upstream over hand-editing. Schema is documented in the file header (operatives, weapons, ploys, equipment, attacker/defender effect IDs).
- **`rules.js`** — Pure Kill Team rule math, no DOM. Exposes `window.KT_RULES`: dice (`rollAttack`, `rollDefence`, `allocateSavesOptimally`), weapon-rule parsing (`parseWeaponRules`), LoS / cover (`shootEnv`, `lightCoverIntervening`, `losBlockedByWalls`), action validation (`validateReposition`/`Dash`/`Charge`/`FallBack`), and `KT_RULES.constants` for all magic numbers (engagement range, AP costs, dash inches, etc.). Add new mechanics here if they have no UI.
- **`maps-data.js`** — `window.KT`. Owns the 28"×24" Tomb-World board geometry, the built-in `TOMB_MAPS`, the piece-based map model (`PIECES`, `compileMap`, `compilePieces` → walls + terrain + objectives + deploy zones), and custom map persistence. The `compileMap` step converts the authored `pieces` array into the runtime `walls` / `terrain` arrays the game and rules consume.
- **`map-creator.js`** — Canvas editor that writes the same piece-based map shape; `KT.saveCustomMap` round-trips through `localStorage`.
- **`presets.js`** — `window.KT_PRESETS`: community-best-loadout preset rosters (same shape as saved rosters; weapon choices may be arrays for multi-weapon loadouts). Selectable directly on game.html's team picker and importable in roster.html.
- **`tacops.js`** — `window.KT_OPS`: the faction→archetype map (all 44 teams, wahapedia-verified), 8 automatable universal Tac Ops (2 per archetype), and the Secure/Loot/Transmission crit ops. Data + pure helpers only; scoring lives in game.js's ops engine.
- **`ai.js`** — `window.KT_AI`, the solo-mode opponent. Runs on a heartbeat, driving the game through `window.__kt_ai_api` (a narrow surface exported by game.js) so every AI action goes through the same validation as human input. Movement uses a 0.5" Dijkstra reachability field over `effectiveWalls`. Tuned defaults target the Plague Marines preset.
- **`game.js`** — Everything else: roster→unit construction, the `state` machine (`teams → initiative → deploy → combat → over`), the per-TP strategy sequence (initiative roll-off, CP, ploys sheet), the ops engine (crit op + tac op scoring, mission actions), Guard/Counteract flows, canvas rendering, the activation panel, shoot/fight modals, and VP scoring. Single closure, single `state` object; UI is rerendered from state.

### Testing beyond `node --check`

`tools/ui-review/` has a Playwright harness (needs `npm install` there once):
- `npm run capture` — screenshots + axe audits of every screen across phone profiles.
- `node ai-test.mjs` — headless AI soak: plays a full 4-TP game (AI Red vs a scripted passive Blue) and reports page errors, movement, and scoring.
- `game.js` exposes `window.__kt_test` (jump straight to combat states) and `window.__kt_ai_api` (the AI's action surface) for scripting.

### Coordinate system & key invariants

- **All distances are in inches.** The board is 28×24, drawn on a 720×720 canvas — never mix pixel and inch units in game logic.
- **Team A = Blue (orange map half), Team B = Red (grey map half).** Display palette in `game.js` (`TEAM_INFO`); the deployment half is determined by `map.split` (`'vertical'` or `'horizontal'`) in `maps-data.js`'s `deployZone`.
- **Operative bases** carry `{ d }` (round, mm) or `{ w, h }` (oval, mm). Convert via `MM_PER_INCH = 25.4`. Round bases render as circles; ovals are currently always drawn long-axis-horizontal regardless of facing.
- **Walls vs. terrain** — Walls block LoS and movement (full cover). Terrain pieces give light cover when intervening AND within 1" of the target, unless the target is within 2" of the shooter (`COVER_FAR_THRESHOLD`). Hatchways/breaches mutate the wall set at runtime via `state.combat.pieceState.open`; always feed `effectiveWalls(map, openPieces)` into LoS checks rather than reading `map.walls` directly.
- **Game structure** — 4 turning points (`KT_RULES.constants.MAX_TURNING_POINTS`); per-TP initiative roll-off (ties go to the player without initiative); CP: 2 at battle start + 1/TP, 2/TP for the non-initiative player from TP2. Movement legs round UP to whole inches.
- **Letter codes** in `assignLetters` keep operative letters unique within a team; duplicates become `T1`, `T2`, etc. Don't rely on `unit.letter` being stable across reorderings.

### When changing rules vs. UI

Rule changes that should be testable in isolation belong in `rules.js` (no DOM access; consume via `KT_RULES`). UI flows, modals, canvas rendering, and the phase machine belong in `game.js`. New constants go in `KT_RULES.constants` so both layers see the same number.
