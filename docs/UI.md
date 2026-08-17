# UI

One responsive codebase (Preact + SVG). No separate mobile build.

## Layouts

| Breakpoint | Layout |
| --- | --- |
| < 900px (phone portrait, phone landscape) | Full-height board page + a bottom tab bar (Board / Play / Log). The decision panel docks **under the board** on the Board tab so a reactive window never hides the dice. |
| ≥ 900px (tablet landscape, desktop) | Three columns: action rail (decisions, setup, activation, score, killzone browser) · board · log. |

Only one layout mounts at a time (`useIsDesktop`, kept in sync with the media query in
`styles.css`). Rendering both would mean two live boards and ambiguous DOM queries.

Touch/pointer rules: 44px minimum targets, 15px inputs (below that iOS zooms on focus),
`touch-action: manipulation`, `overflow-x: clip` on every page, app-style viewport meta
(the page itself never scrolls; the board owns its own pan/zoom), and a
`prefers-reduced-motion` block that disables every animation.

Tested viewports (Playwright): iPhone SE 375×667, Pixel 7 412×915, desktop 1440×900. The
smoke suite asserts zero horizontal overflow and zero console errors on all three.

## State → screen

```
setup.step = rollOff          -> Setup: "Roll off" (dice into the log)
           = chooseDropZone   -> Setup: initiative choice + drop-zone choice
           = selectOperatives -> Setup: hand-over screen, then the roster builder (secret)
           = deploy           -> Setup: "Place X" arms a placement; tap the board to drop it
phase = strategy              -> ActivationPanel shows the step; gambits in the action rail
phase = firefight, no active  -> ActivationPanel: activate (Engage/Conceal) or counteract
phase = firefight, active op  -> ActivationPanel: the action sheet + shoot/fight target lists
state.sequence != null        -> SequenceOverlay draws the dice above the operatives
state.pending[0] != null      -> DecisionPanel takes over (and docks under the board on phones)
phase = battleEnd             -> final score, kill grades, reveal
```

## Dice

`src/ui/dice/Dice.tsx`. Dice are drawn **inside the board's world transform**, so a pool sits
above its operative and follows pan and zoom. Each `Die` keeps its `id` for the whole
sequence, so:

- a re-roll animates only the dice that were re-rolled, and shows `↻4` — what the die used to be;
- retained / discarded / blocked / struck are visually distinct, not just counted;
- Accurate's auto-successes render as unrolled ✓ dice with their source in the tooltip;
- the cover save appears as a locked die in the defence pool.

`DamageFloat` rises off the target; `FiringLine` draws the tracer and the target rings.

On very small screens the same component can dock to a bottom sheet with a leader line back
to the operative — the pool is positioned by an `anchor`, so this is a prop change, not a
second implementation.

## Reactive windows

Everything the rules let a player choose is a `PendingDecision` rendered by
`src/ui/DecisionPanel.tsx`: rerolls (Ceaseless / Balanced / Relentless / Command Re-roll,
either player), cover-vs-obscured, the obscured discard, Severe/Rending/Punishing retention,
defence allocation (auto-optimal with a manual override), the fight phase's alternating
strike-or-block, On Guard interrupts and firefight ploys. Each carries `sourceText`, shown
behind a disclosure, so the printed rule is one tap away.

Pass-and-play: the panel can be given a `viewer`, and it then shows "Hand the device to
Player N" instead of the options. The setup wizard uses the same hand-over pattern for secret
roster, equipment and tac-op selection.

## Targeting-line inspector

Tap a shooter, tap a target. The panel reports visible / not visible, the terrain part that
blocks the line (naming the rule: Wall, Blocking, Barred), what makes the target obscured or
in cover, the Vantage Accurate value, the base-to-base distance, and both operatives' feet and
head heights. Below that is a side-elevation SVG along the shooter→target axis: distance on x,
height on y, terrain drawn at its true `z0`–`z1`, the visibility line green or red, and terrain
crossed by *every* targeting line outlined in accent (wholly intervening).

## Killzone browser

A contact sheet of all 24 layouts grouped by killzone, each thumbnail drawn from the extracted
geometry by the same `Board` component the game uses. The source card PNGs are not bundled
(GW artwork, public repo); `docs/maps/overlays/` holds the extraction overlays for local
verification.

## Accessibility

- Colour is never the only signal: dice carry pip faces and `aria-label`s ("5, critical
  success"), operatives carry letters, terrain carries `<title>` with its types and heights.
- The board is `role="img"` with a killzone label; tabs are a real `tablist`/`tab` pair with
  `aria-selected`; the decision panel is `aria-live="polite"`.
- `prefers-reduced-motion` disables dice, damage and tracer animation.
- Team colours are orange (P1) and blue-grey (P2) rather than red/green.

## Board pan and zoom

A 30"×22" killzone drawn to fit a phone puts a 25 mm base at about 12 px across — too small
to place an operative accurately, and useless for measuring. So the board's `viewBox` is a
movable window, driven by gestures.

All the maths is in **`src/ui/boardView.ts`** — pure, DOM-free, unit-tested in
`tests/boardView.test.ts`. `Board.tsx` only turns pointer events into calls on it.

| Gesture | Effect |
| --- | --- |
| Pinch (two fingers) | Zoom about the starting midpoint; the pinched point stays under the fingers |
| Two-finger drag | Pan (falls out of the same `pinch` call, at scale factor 1) |
| One-finger drag | Pan — **only when zoomed in**; at fit there is nowhere to go |
| Mouse wheel / trackpad | Zoom anchored at the cursor, not at the centre |
| − / + / ⤢ buttons | Step out, step in, fit the whole killzone; each a 44px target, with a zoom-% readout beside them |

Three coordinate spaces, and `boardView.ts` names every function for the one it speaks:

- **world** — inches, origin bottom-left, +y **up**. Everything in `src/core/**`.
- **view** — the `viewBox` window: inches, origin top-left, +y **down**.
- **screen** — CSS px, what a `PointerEvent` carries.

The world→view flip for *rendering* still happens exactly once, in `Board.tsx`'s
`worldTransform`; the converters in `boardView.ts` are pointer maths and the renderer never
calls them. `screenToWorld` also undoes the letterboxing that `preserveAspectRatio="xMidYMid
meet"` produces whenever the pane is not the board's aspect ratio (which is always, on a
phone) — so `onBoardClick` lands on the inch you touched at any zoom. That is verified
against the browser's own rendering: the rendered position of each objective marker matches
`worldToScreen` to 0.000 px at fit, zoomed and panned into a corner.

Rules the layer keeps:

- The window is **aspect-locked to the board** and clamped inside it, so the killzone can
  never be lost off screen and the letterboxing never shifts as you zoom.
- Zoom range is fit-to-board at one end and 9" of the short side at the other
  (`MIN_SPAN_IN`), where a 25 mm base draws ~30 px on a 375 px phone. Further magnification
  only wastes screen.
- **A second finger cancels whatever the first was doing**, and any press that wanders more
  than 8 px swallows its trailing `click` — so a pinch or a pan can never place an operative
  or open the targeting inspector.
- Everything drawn inside the world transform follows pan and zoom for free: terrain,
  operatives, markers, and the `overlays` (dice pools, firing line) — `SequenceOverlay`
  needed no changes.
- The controls sit **under** the board, never over it. Every killzone's drop zones run along
  the left and right edges, which is exactly where an overlaid cluster would steal the taps
  that place operatives. It costs ~53 px of height; the board keeps the rest of the pane.
- `variant="thumb"` boards (the 24 killzone-browser previews) stay inert: no gestures, no
  controls, always the whole killzone.

Known nits: pan and zoom are internal to `Board`, so switching killzone resets the window
(deliberate) but a caller cannot yet drive it — e.g. to auto-frame the operative being
activated, or to keep the window across a phone tab switch. Dice pools are sized in world
inches, so they grow with the zoom rather than staying a constant size on screen.

## Roster builder

`src/ui/roster/` — Core Rules › SELECT OPERATIVES. Reachable two ways: the **Rosters** tab
(phone) / topbar button (desktop) as a workbench outside a battle, and inside the setup
wizard at `setup.step = 'selectOperatives'`, behind the same pass-and-play hand-over screen
(each player builds secretly, then both are revealed).

**One validator, no second opinion.** Legality is decided only by `validateRosterFor`
(`src/teams/selection.ts`), driven by the `selection` block of `data/teams/<slug>.json`. The
screen re-asks it after every change and never re-implements a rule:

| Screen affordance | How it is decided |
| --- | --- |
| `＋` add button live / disabled | a trial validation of `picks + this entry`; the disabled reason is the validator's own sentence, so "you can only select a C.A.T. UNIT operative if your kill team includes a SURVEYOR operative" is what the player reads |
| slot chips (`1/1 leader`, `9/9 selections`, `group 2: 9/9`) | `usage()` in `rules.ts` — pure counting over `selectionCost` (a "counts as two selections" entry eats two, a half-selection entry eats 0.5) and the printed group counts |
| the violation list | `validation.errors`, each quoting the rule that produced it; violations show `✖`, "not finished yet" counts show `•` |
| confirm enabled | `validation.ok` — an illegal kill team can never reach `SelectRoster` |

**Loadouts.** Every `loadouts` / `optionGroups` / `fixedChoiceGroups` row an entry carries
becomes a select. What the operative ends up with is `weaponsForPick`, and the weapons no
selection option names are listed with an "always carried" tag rather than as a choice —
**including `Limited x` weapons** (the Navis Grenadier keeps its demolition charge). The
resolved names ride along on the `SelectRoster` intent and are recorded with
`selection.applyLoadouts`.

**Warnings, never silence.** Printed constraints the shared validator cannot express
(docs/TEAM-DATA.md §5 — `maxItem`, `exclusiveItems`, `distinctOptions`, `exclusive`, and the
six `custom` hooks) are listed under "⚠ N rules this app does not check", with their verbatim
text. Six teams go further: their printed list cannot satisfy the validator's slot arithmetic
at all (leader-in-list teams, a group fed by a faction rule, a group whose maximums cannot
reach its count). `supportProblems()` detects that from the data — not a hard-coded list —
flags the team in the picker (⚠ rules gap), explains it, and the confirm button says
"legality not enforced" for those teams only.

**Persistence.** Named rosters live in `localStorage` under `kt24.rosters.v1`
(`src/ui/roster/storage.ts`, deliberately outside the pure core), with JSON import/export of
`{format: "kill-team-mobile/rosters@1", rosters: [...]}`. A saved roster is `teamId` +
`RosterPick[]`, i.e. exactly what `SelectRoster` wants, so it can be carried between devices.

## Known gaps

- Choosing a loadout records the operative's weapons in `state.opState.loadout`, but
  `weaponsOf` does not read it yet — an operative still fights with every weapon on its
  datacard.
- PWA manifest / service worker and replay import are not built. `Store.exportReplay()`
  already emits `{ seed, mapId, critOpId, intents[] }`.
