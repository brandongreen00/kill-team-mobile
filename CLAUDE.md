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
| `roster.html` | `factions.js` (inline script) | Build kill teams; saves to `localStorage['kt.rosters.v1']` |
| `game.html` | `factions.js`, `maps-data.js`, `rules.js`, `game.js` | The actual game runtime |

`game.js` reads the chosen map from `sessionStorage['kt.mapId']` and the rosters players pick from `localStorage['kt.rosters.v1']`. There is no server, no API, no auth — all state is per-browser.

### Module responsibilities

- **`factions.js`** — `window.FACTIONS` array. **Vendored from `brandongreen00/ballistica-imperialis` (`src/data/factions.js`)**, sourced from wahapedia.ru/kill-team3. Treat it as data, not code: prefer pulling updates from upstream over hand-editing. Schema is documented in the file header (operatives, weapons, ploys, equipment, attacker/defender effect IDs).
- **`rules.js`** — Pure Kill Team rule math, no DOM. Exposes `window.KT_RULES`: dice (`rollAttack`, `rollDefence`, `allocateSavesOptimally`), weapon-rule parsing (`parseWeaponRules`), LoS / cover (`shootEnv`, `lightCoverIntervening`, `losBlockedByWalls`), action validation (`validateReposition`/`Dash`/`Charge`/`FallBack`), and `KT_RULES.constants` for all magic numbers (engagement range, AP costs, dash inches, etc.). Add new mechanics here if they have no UI.
- **`maps-data.js`** — `window.KT`. Owns the 28"×24" Tomb-World board geometry, the built-in `TOMB_MAPS`, the piece-based map model (`PIECES`, `compileMap`, `compilePieces` → walls + terrain + objectives + deploy zones), and custom map persistence. The `compileMap` step converts the authored `pieces` array into the runtime `walls` / `terrain` arrays the game and rules consume.
- **`map-creator.js`** — Canvas editor that writes the same piece-based map shape; `KT.saveCustomMap` round-trips through `localStorage`.
- **`game.js`** — Everything else: roster→unit construction, the `state` machine (`teams → initiative → deploy → combat → over`), canvas rendering, the activation panel, shoot/fight modals, and VP scoring. Single closure, single `state` object; UI is rerendered from state.

### Coordinate system & key invariants

- **All distances are in inches.** The board is 28×24, drawn on a 720×720 canvas — never mix pixel and inch units in game logic.
- **Team A = Blue (orange map half), Team B = Red (grey map half).** Display palette in `game.js` (`TEAM_INFO`); the deployment half is determined by `map.split` (`'vertical'` or `'horizontal'`) in `maps-data.js`'s `deployZone`.
- **Operative bases** carry `{ d }` (round, mm) or `{ w, h }` (oval, mm). Convert via `MM_PER_INCH = 25.4`. Round bases render as circles; ovals are currently always drawn long-axis-horizontal regardless of facing.
- **Walls vs. terrain** — Walls block LoS and movement (full cover). Terrain pieces give light cover only if `>2"` from the shooter and on the target side (`COVER_FAR_THRESHOLD`). Hatchways/breaches mutate the wall set at runtime via `state.combat.pieceState.open`; always feed `effectiveWalls(map, openPieces)` into LoS checks rather than reading `map.walls` directly.
- **Letter codes** in `assignLetters` keep operative letters unique within a team; duplicates become `T1`, `T2`, etc. Don't rely on `unit.letter` being stable across reorderings.

### When changing rules vs. UI

Rule changes that should be testable in isolation belong in `rules.js` (no DOM access; consume via `KT_RULES`). UI flows, modals, canvas rendering, and the phase machine belong in `game.js`. New constants go in `KT_RULES.constants` so both layers see the same number.
