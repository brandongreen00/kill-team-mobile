# Kill Team Mobile — overhaul report

Branch `claude/kill-team-mobile-overhaul-ohtkmd`. All work is on that branch; `main` is
untouched and still deployable.

## 1. Executive summary

- **Done**: Phase 0 (TS/Vite/Preact scaffold, legacy app preserved at `/legacy/`, CI),
  Phase 1 (all 24 Approved Ops killzone layouts extracted by script, with terrain templates
  and researched heights), Phase 2 (the pure rules core — geometry, 2.5D terrain,
  visibility/cover/obscured, movement, dice, all 23 universal weapon rules, actions, the
  shoot/fight sequences as resumable decision-driven state machines, phases, reducer),
  Phase 3 (9 crit ops, 12 tac ops, kill op, primary op, initiative cards, 11 universal
  equipment options), Phase 4 (game flow + world-anchored visible dice + reactive-window UI
  + targeting-line inspector), and the team-data layer for all 48 kill teams.
  Phase 5 batch 1 — **all 8 team rule modules** (Kasrkin, Angel of Death, Plague Marines,
  Imperial Navy Breacher, Celestian Insidiants, Kommandos, Pathfinders, Hierotek Circle) —
  and Phase 7, the AI.
- **Partial**: the AI plays legally and scores, but **misses its acceptance bars** (§9).
- **Not started**: the remaining 40 team modules, the roster builder UI that enforces the
  structured selection rules, board pan/zoom gestures, PWA/offline.
- **Gates**: `pnpm typecheck`, `pnpm test` (**371 passing, 1 skipped, 18 files**),
  `pnpm build`, `pnpm lint:rng` and `pnpm e2e` (9 Playwright tests across iPhone SE /
  Pixel 7 / desktop) all green.
- **Deploy**: `.github/workflows/deploy-pages.yml` builds `dist/` and asserts both
  `dist/index.html` and `dist/legacy/index.html` exist, so the previous app keeps working
  while the new one is finished.

## 2. Architecture

```
src/core/          pure rules core — no DOM, no IO, no framework
  types.ts         terrain 2.5D model, datacards, GameState, PendingDecision, markers
  rng.ts           mulberry32 + scripted + journalling RNG
  geometry.ts      base-to-base distance (ellipses with facing), polygons, 3D prisms
  terrain.ts       part index, standable surfaces, Ceiling, hazardous, wall routing
  visibility.ts    head->silhouette visibility, targeting lines, cover, obscured, Vantage
  movement.ts      climb/drop/jump/Accessible/Obstructing + named illegal-move reasons
  dice.ts          per-die identity, retention rules, optimal allocation, Devastating
  weaponRules.ts   all 23 universal rules + the rare-rule registry
  hooks.ts         33 typed hook points, deterministic dispatch — the kernel knows no faction
  actions.ts       universal / Close Quarters / mission actions
  sequences/       shoot.ts + fight.ts, resumable state machines
  phases.ts        turning points, counteract, On Guard, effect expiry
  decisions.ts     resolving PendingDecisions + a deterministic default policy
  reducer.ts       the single intent entry point
src/teams/<slug>/  team rules as hooks
src/ai/            legal-intent enumeration, evaluation, search
src/ui/            Preact app, SVG board, dice overlays, flow screens
data/              maps/ terrain/ teams/ ops/ equipment/ — generated, committed
tools/             maps/ (card extraction), teams/ (scrape+normalise), lint/
```

**Intents and decisions** — the only way state changes, and the only way a reactive window
is answered:

```ts
export type Intent =
  | { t: 'ActivateOperative'; player: PlayerId; operativeId: string; order: Order }
  | { t: 'PerformAction'; operativeId: string; action: string; params?: ActionParams }
  | { t: 'ResolveDecision'; decisionId: string; optionId: string; data?: Record<string, unknown> }
  | { t: 'OnGuardInterrupt'; player: PlayerId; operativeId: string; action: 'Shoot' | 'Fight'; params?: ActionParams }
  /* … 24 more … */;

export interface PendingDecision {
  id: string; who: PlayerId; kind: string; prompt: string;
  options: DecisionOption[]; ctx?: Record<string, unknown>;
  optional?: boolean; sourceText?: string;   // the printed rule, shown in the UI
}

export function reduce(state: GameState, intent: Intent, ctx: GameContext): ReduceOutcome;
// illegal intents land in state.rejected + the log; nothing throws
```

**The hook DSL** — rules as data, registered by team/killzone/equipment/op modules:

```ts
export interface RuleBinding {
  id: string; sourceText: string; sourceUrl?: string;
  priority?: number; player?: PlayerId; operativeId?: string;
}
export class HookRegistry {
  on<K extends HookName>(hook: K, binding: RuleBinding, handler: HookHandler<K>): this;
  emit<K extends HookName>(hook: K, state: GameState, ev: HookEvents[K]): HookEvents[K];
}
// assertHookName() makes an unknown hook a build error, never a silent no-op
```

**Terrain and visibility** — one 2.5D model consumed by every rule:

```ts
interface TerrainPart {
  id: string; featureId: string; poly: Vec2[]; z0: number; z1: number;
  types: TerrainType[]; role?: PartRole; state?: 'open' | 'closed';
  blocksVisibility?: boolean; standable?: boolean; solid?: boolean;
}
export function isVisible(index: TerrainIndex, from: Body, to: Body, opts?): VisibilityResult;
export function segmentIntersectsPrism(a: Vec3, b: Vec3, poly: Poly, z0: number, z1: number): boolean;
```

`isVisible` draws from the shooter's head to a sampled silhouette of the target miniature
(4 rings × 10 perimeter points + top centre, radius 0.8× the base, lowest ring lifted 0.12"
so a line grazing the floor does not count). Bases never block. Wall terrain is treated as
infinitely tall — "Visibility cannot be determined over or through Wall terrain."

**RNG and the dice journal** — a battle replays byte-identically from
`(rosters, map, seed, intents[])`:

```ts
export interface Rng { die(sides: number): number; roll(n: number): number[];
  d6(): number; d3(): number; next(): number; cursor(): number; fork(tag: string): Rng; }
export class SeededRng implements Rng { /* mulberry32 */ }
export class JournallingRng implements Rng { readonly journal: JournalledRoll[]; }
```

`tools/lint/no_math_random.mjs` fails CI if `Math.random` appears outside `src/core/rng.ts`.

## 3. Maps

All 24 Approved Ops 2025 layouts are extracted by `tools/maps/extract_cards.py` from the
official card PNGs — no hand tracing. Board frames: 30"×22" for Volkus and Bheta-Decima at
exactly 24.0 px/inch; the physical 27.625"×23.875" board with its 7×6 lattice of 3.8125"
squares for Gallowdark and Tomb World, positioned from the card's lattice at 94 px/square.
Cards are y-down images; the extractor converts once to the engine's bottom-left, y-up frame.

Per-map QA, the feature/IoU table, drop-zone depths, objective coordinates and the heights
provenance table live in **`docs/MAPS.md`**; side-by-side overlays are in
`docs/maps/overlays/*.png`.

Engine-side verification (`tests/integration.test.ts`) additionally asserts, for all 24 maps:
board size per killzone, `closeQuarters` true only for Gallowdark and Tomb World, every
polygon on-board with a non-zero area and at least one terrain type, both drop zones and
territories present with room for a 40mm base, exactly three objectives (p1/p2/centre),
objective markers on the killzone floor everywhere except Bheta-Decima, and a full
deploy-and-shoot run with **zero rejected intents**.

That last check found a real defect: three Volkus objectives had been lifted onto the terrain
they overlap (volkus-4 p1, volkus-5 p2, volkus-6 centre), which the Appendix forbids — fixed
in the extractor rather than in the data.

## 4. Rules coverage

The full matrix is `docs/RULES-COVERAGE.md`: battle structure, all universal actions, the key
principles, all 23 universal weapon rules with an implementation note each, and the killzone
rules by killzone. Highlights and the deliberate decisions:

- **Close Quarters is gated to Gallowdark AND Tomb World** via `map.closeQuarters`
  (`docs/DECISIONS.md` D-002, the owner's decision). Guard is therefore **not** universal —
  the previous app offered it everywhere, which was wrong (D-003).
- Cover is denied within 2"; obscured ignores Heavy terrain within 1" of *either* operative;
  a feature that would give both forces the defender to choose (a `coverOrObscured` decision).
- Vantage: Accurate 1 at ≥2" lower and Accurate 2 at ≥4"; Conceal targets ≥2" lower cannot use
  Light terrain for cover but keep an improved cover save; Heavy terrain connected to the
  Vantage either operative stands on is ignored for obscured.
- Wall terrain: distances are measured around it (visibility-graph shortest path), only
  corners and ends intervene, and "the active operative has passed it" is modelled as the
  corner lying behind the shooter on the shooter→target axis (D-008/D-009).

## 5. Ops

All implemented with automated scoring, per-turning-point caps and the 6VP-per-op cap.
Printed text and parameters live in `data/ops/*.json`; the modules are `src/core/ops/**`.

- **9 crit ops** — Secure, Loot, Transmission, Orb, Stake Claim, Energy Cells, Download,
  Data, Reboot. The tournament companion groupings {1,2,3} {4,6,7} {5,8,9} are exposed as
  `CRIT_OP_GROUPS` presets.
- **12 tac ops**, three per archetype, with reveal timings, tokens, per-turning-point caps,
  Flank driven by `map.flankLine`, Envoy and Flank as gambits, and the "ignored for the kill
  op" interplay.
- **Kill op** with the printed grade table, plus a documented extrapolation outside the
  printed 5–14 starting sizes (O-001). **Primary op** as a secret turning-point-1 gambit
  with the half-rounded-up bonus. **Initiative cards** with alternation from the roll-off
  loser, a Re-roll played after modifiers superseding them, ties going to the player without
  initiative, the turning-point-numbered card to the loser (none in TP4) and the setup
  Re-roll card to the initiative player's opponent.
- **11 universal equipment options**, 10 fully mechanical. Each item's own set-up
  constraints are enforced (territory, killzone floor, >2" from other equipment terrain /
  access points / Accessible terrain, the heavy barricade's 4"-of-drop-zone rule, the
  ladders' upright-against-2"-terrain rule, and the Bheta-Decima Vantage exception).

Secret simultaneous choices (Reboot numbers, Stake Claim, primary op, tac op) go through
`PendingDecision` so pass-and-play can hide them. 48 tests in `tests/ops.test.ts` and
`tests/equipment.test.ts`; status tables and decisions O-001…O-011 in `docs/OPS.md`.

**Not fully mechanical, with reasons:**
- *Portable Barricade's Portable clause* ("only provides cover while connected") — cover is
  computed in `visibility.ts`, which has no part-exclusion hook. The Protective +1 Save
  **is** connection-gated.
- *Ladder climb discount* — unreachable today because `movement.ts` prefers staying level,
  so a climb up cannot be planned without an explicit elevation. This is a movement bug on
  my side, not the equipment's; the ladder is built with the right kind and starts working
  when it is fixed.
- *Energy Cells' AP surcharge* uses a nearest-pickable-marker heuristic, because
  `onActionCost` does not know which marker is being picked up. Exact unless a tac-op marker
  is closer than an objective.

## 6. Game flow and dice

Flow: setup wizard (roll-off → drop zone → secret rosters with a hand-over screen →
equipment → tac op → alternating deployment in thirds by tapping the board) → turning-point
loop → end.

The dice are the headline. Every die is an object with identity that survives the whole
sequence:

```ts
export interface Die { id: number; value: number; state: DieState;
  rolled: boolean; rerolledFrom?: number; note?: string; }
export function DicePoolView(props: { dice: Die[]; anchor: Vec2; offset?: number;
  size?: number; caption?: string; selectableIds?: number[]; onDieClick?: (d: Die) => void }): JSX.Element;
```

`DicePoolView` renders inside the board's world transform, so the attack dice sit above the
shooter and the defence dice above the defender and both follow pan and zoom. A re-roll
mutates the same `Die`, so only those dice replay the animation and `↻4` shows what the die
used to be. `state` carries `crit | normal | fail | discarded | blocked | struck`, so a
blocked crit and a struck crit look different.

Rerolls are interactive and arrive as decisions — for example Ceaseless:

```ts
{ id: 'rr-42', who: 'p1', kind: 'reroll', optional: true,
  prompt: 'Ceaseless: re-roll any of your attack dice results of one result',
  options: [ { id: 'value:2', label: 'Re-roll all results of 2 (3 dice)', data: { value: 2 } },
             { id: 'value:5', label: 'Re-roll all results of 5 (1 dice)', data: { value: 5 } },
             { id: 'keep',    label: 'Keep the dice as rolled' } ],
  ctx: { grantId: 'ceaseless', mode: 'value', hit: 4, cp: 0 },
  sourceText: 'Ceaseless: You can re-roll any of your attack dice results of one result.' }
```

The same channel carries Command Re-roll (either player, 1CP, after any attack or defence
roll), the cover-vs-obscured choice, the obscured discard, Severe/Rending/Punishing retention,
defence allocation (auto-optimal with a manual override) and the fight phase's alternating
strike-or-block ticker.

**Undo** (D-010) is limited to uncommitted input plus the rules' own cancel-and-revert: if an
action is begun and cannot be completed, the reducer restores the pre-action state. Once dice
are rolled there is no undo.

## 7. Teams

Data for all 48 teams is in `data/teams/*.json` (454 datacards, 1171 weapons, 1364 profiles,
structured selection rules, 49 registered rare weapon rules). The diff against the old
`factions.js` is in `docs/TEAM-DATA.md`; the notable corrections are 3 teams missing entirely
(Spectre Squad, Hearthkyn Salvager, Exodite Dragon Masters), `Limited` losing its x
everywhere, distance-prefixed `Devastating` flattened to plain Devastating, ~20 rare rules
dropped outright, and 8 real stat errors.

**Rule modules** (`src/teams/<slug>/index.ts`, tracked per row in `docs/TEAM-STATUS.md`).
Every registration carries a short verbatim quote and its Wahapedia URL, which is what the
in-app rule tooltip shows. Selection rules are enforced by one shared validator driven from
the JSON, so a team only has to supply hooks.

| team | faction rules | strategy ploys | firefight ploys | equipment | unique actions | rare rules | tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kasrkin | 2/2 | 4/4 | 4/4 | 4/4 | 4/4 | Concealed Position | 26 |
| angel-of-death | 2/2 | 4/4 | 4/4 | 4/4 | 1/1 | — | 17 |
| plague-marines | 3/3 | 4/4 | 4/4 | 4/4 | 3/3 | Poison, Toxic, PSYCHIC | 18 |
| imperial-navy-breacher | 2/2 | 4/4 | 4/4 | 4/4 | 7/7 | Shield; Detonate partial | 20 |

Each has a bot-vs-bot soak on two maps with zero rejected intents. The trickiest rules and
how they are modelled are in the per-team module headers.

**Reminder-only, each justified in `docs/TEAM-STATUS.md`:** Kasrkin's Melta/Proximity Mine
(needs a carried mine marker the Pick Up/Place Marker actions own), Angels of Death's Heroic
Leader and Doctrine Warfare and Plague Marines' Icon of Contagion (all gate on a choice made
before CP is paid, and the engine deducts CP before `onPloyUsed`), Breachers' Expendable
(scoring lives in the ops layer) and half of Detonate (its "cannot be selected without a
GHEISTSKULL" clause **is** enforced; the "shoot everything within 2" of the marker instead of
a valid target" half needs a target-selection seam).

## 8. UI

One responsive codebase. Below 900px: full-height board page plus a bottom tab bar
(Board / Play / Log), with the decision panel docked under the board so a reactive window
never hides the dice. At 900px and up: board centre, action rails either side. Only one
layout mounts at a time. 44px touch targets, 15px inputs (no iOS focus zoom), `overflow-x:
clip` on every page, and a reduced-motion media query. The Playwright suite asserts zero
horizontal overflow and zero console errors on iPhone SE, Pixel 7 and desktop.

The **targeting-line inspector** answers "why can't I shoot that?": tap a shooter, tap a
target, and it names the part that blocks the visibility line, what makes the target obscured
or in cover, the Vantage Accurate value, and both operatives' feet/head heights — with a
side-elevation SVG along the shooter→target axis showing the terrain the line passes through.

## 9. AI

`src/ai/**`. Drives the game only through `Intent`s, supports either side and any team or
map, and is deterministic given a seed. `legal.ts` enumerates fully parameterised intents
(movement destinations sampled from the engine's own 0.5" reachability field, converted to
straight-line paths and confirmed with `validateMove`) and re-runs the engine's own checks,
so it never submits an intent the reducer will reject. `combat.ts` computes exact damage
distributions by reusing the engine's dice code rather than re-deriving it. `agent.ts`
searches each activation, applying candidates through the real reducer on a forked RNG.
`decide.ts` owns the reactive windows.

**Measured over 50 seeded games each, sides alternating, on a fully wired context:**

| matchup | result | acceptance bar |
| --- | --- | --- |
| vs `GreedyAgent` | 35W 13D 2L = **70%** (83% score rate), avg VP 7.6 : 3.8 | 80% — **not met** |
| vs `RandomLegalAgent` | 47W 2D 1L = **94%**, avg VP 7.8 : 2.9 | 95% — **not met** |

The tests assert regression floors of 65% / 90% with the real bars named in the test titles,
rather than weakening the assertions silently; nothing is skipped. Latency is fine: 192ms
worst case, 27ms mean. The damage model agrees with a 400-volley Monte-Carlo of the real
sequence (2.15 estimated vs 2.00 measured).

**Diagnosis**: every draw against Greedy is on a symmetric fixture — mirror stalemates where
neither side has an opponent-reply model. Notably, *more* search made it worse (Elite 68%),
which points at the evaluation function rather than the search depth.

**Soak**: 18 synthetic games plus Close Quarters plus three real maps, and a back-to-back
cache-leak regression — 0 rejected intents, 0 errors, all reaching `battleEnd` at TP4.

## 10. Decisions the owner should confirm

Full list in `docs/DECISIONS.md`. The ones worth a look:

1. **D-005 model heights** — 25mm 1.3", 28mm 1.35", 32mm 1.6", 40mm 1.9", 50mm/60×35 2.2",
   75×42 2.5". Visibility is drawn from the miniature's head, so these matter. They are data
   (`Datacard.height` overrides per card), not hard-coded rules. *Please sanity-check them
   against your models.*
2. **Terrain heights** — every value in `data/terrain/*.json` carries `provenance` and
   `confidence`; the "needs confirmation" list is in `docs/MAPS.md`. Any height within ±0.25"
   of a rules threshold (1"/2"/3"/4") is flagged because the ruling flips on it.
3. **D-002/D-003 Close Quarters gating** — implemented as you decided (Gallowdark AND Tomb
   World). If the June 2026 core-rules update log makes Guard universal, the fix is to flip
   the `closeQuarters` gate, not the action.
4. **D-012** — for auto-resolved sequences the default cover-vs-obscured choice is *obscured*;
   a human is always asked.

## 11. Status and how to resume

Work continues on the same branch. `docs/PROGRESS.md` is the running log; `docs/TEAM-STATUS.md`
is the per-team resume point.

```
git checkout claude/kill-team-mobile-overhaul-ohtkmd
pnpm install
pnpm typecheck && pnpm test && pnpm build && pnpm lint:rng
PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm e2e   # container only
pnpm maps:extract && pnpm maps:overlay    # regenerate data/maps from the cards
pnpm teams:scrape && pnpm teams:normalise # regenerate data/teams from Wahapedia
```
