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
           = selectOperatives -> Setup: hand-over screen, then the team picker (secret)
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

## Known gaps

- Board pan/zoom gestures (pinch, two-finger pan, wheel) are not yet wired — the board
  currently fits the viewport. `Board` already takes a `viewport` prop, so this is a gesture
  layer, not a rewrite.
- The roster builder that enforces the structured selection rules is not built; the setup
  wizard currently takes the first six datacards of a team so a battle can start.
- PWA manifest / service worker and replay import are not built. `Store.exportReplay()`
  already emits `{ seed, mapId, critOpId, intents[] }`.
