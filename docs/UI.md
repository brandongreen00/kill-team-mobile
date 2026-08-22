# UI

One responsive codebase (Preact + SVG). No separate mobile build.

## The model: one stage, one command surface

There is no tab bar. The old shell had four (Board / Play / Rosters / Log) and it broke on the
first thing a player has to do: "tap the board to place A" was printed on the Play tab while
the board lived on the Board tab, with nothing on the board to say what was armed, where it
was legal, or that a tap had been refused.

A tab bar is for peer destinations you choose between. A battle is a wizard followed by a turn
loop: at every moment there is exactly **one** thing to do, and the game already knows what it
is. So:

```
header.topbar   the battle's vital signs — VP and CP for both sides, whose turn, the menu
main.stage      the killzone, mounted once, never navigated away from
  .board-pane   inset from the bottom by --sheet-rest ONLY
  .sheet        the CommandPlan for the current state, over the board
  .toasts       the reducer's own words when something is refused
```

`commandPlan(state)` in `src/ui/command/index.tsx` maps `GameState` to exactly one
`CommandPlan`: an eyebrow, a one-sentence title, up to two actions, an expandable body, plus
where to point the board and what the next tap on it means. The UI stores no "where am I" that
could disagree with the state. A state with no branch falls through to a loud placeholder
rather than an empty panel.

The three things that genuinely are separate destinations — the roster workbench, the battle
log, the killzone browser — are full-screen routes reached from the menu, dismissed with one
Back.

### Precedence

`pending[0]` → `opState.guardOffer` → route → setup step → phase.

`guardOffer` is second and deliberately so: On Guard is **not** a `PendingDecision`. The
reducer writes `state.opState.guardOffer` and does not block on it, so the UI is the only thing
that enforces the window. Without that branch the active player simply walks past their
opponent's interrupt. It is only ever raised on a Close Quarters killzone (D-002).

### Window classes

| Class | Query | Layout |
| --- | --- | --- |
| compact | anything else | stage + **bottom sheet** with three detents |
| side | `(max-height: 560px) and (min-width: 640px)` | stage + **side sheet**, 400px column |
| desktop | `(min-width: 1200px)` | left rail (the plan) · board · right rail (log) |

Three columns start at **1200px**, not 900px: at 900px a 360px rail and a 320px log leave the
board 220px, which is worse than the phone layout it was meant to improve on. Between a phone
and 1200px the stage-plus-sheet layout *is* the right answer for a tablet.

A phone held sideways has ~390px of height; a bottom sheet takes half of it. The side sheet
gives the board 405×281 instead of 405×88.

## State → screen

| State | `plan.id` | Board | Sheet |
| --- | --- | --- | --- |
| `setup.step = rollOff` | `setup.rollOff` | whole killzone | "Roll off for initiative" · **Roll off** |
| `= chooseDropZone`, no initiative yet | `setup.initiative` | — | who takes initiative |
| `= chooseDropZone` | `setup.dropZone` | both zones tinted and **tappable** | take orange / take grey |
| `= selectOperatives`, not handed over | `setup.handover` | — | "Hand the device to Player N" |
| `= selectOperatives` | `setup.selectOperatives` | — | opens the roster route |
| both rosters in, no tac op | `setup.loadout` | — | equipment (≤4) + tac op, secret, per player |
| both tac ops in | `setup.reveal` | — | **Reveal and deploy** → `BeginDeployment` |
| `= deploy` | `setup.deploy` | **framed on the deploying drop zone**, everything else masked out; ghost armed | "Place A — …" · "3 of 9 placed" · Undo |
| all deployed | `setup.deployDone` | whole killzone | **Begin the battle** |
| `phase = strategy` | `strategy.<step>` | — | the step, and the gambit list when there is one |
| `firefight`, no active operative | `firefight.activate` | framed on that player's ready operatives, each ringed | pick one, then Engage / Conceal |
| `firefight`, counteract offered | `firefight.counteract` | eligible ringed | Decline is **quiet** and says it forfeits the turning point |
| `firefight`, active operative | `firefight.act` | framed on it | AP pips, Shoot / Fight / action list |
| …counteracting | `firefight.counteracting` | as above | one free 1AP action, no Guard, 2" cap |
| a move armed | `firefight.move` | reach field, path, ghost | live distance, Confirm / Cancel |
| a shot armed | `firefight.shoot` | targets ringed | per-target cover / obscured / distance |
| `opState.guardOffer` | `firefight.guardInterrupt` | eligible ringed | interrupt or decline |
| `pending[0]` | `decision.<kind>` | dimmed, dice still on it | the prompt, options, rule text |
| …not the holder's | `decision.handover` | dimmed | "Hand the device to Player N" |
| `endOfTP` / `battleEnd` | `endOfTP` / `battleEnd` | — | score, then the next TP / the result |

## The command sheet

Three detents, and the reason there are three:

- **rest** — exactly the prompt and its primary action, *measured*, never taller than it needs
  to be. The board owns everything above it.
- **half** (52% of the stage) — the full option list, board still readable.
- **full** (92%) — long content: a datacard, the rule text behind a decision.

The board pane is inset by the **rest** height only, so expanding the sheet never reflows the
board and the viewport aspect never changes mid-gesture. The peek is its own grid row, so at
rest the scroller is exactly zero tall and no half-clipped sentence shows under the button.

Dragging is initiated from the grab handle alone, which sidesteps scroll chaining entirely: a
finger inside the body always scrolls the body. Tapping the handle cycles the detents, which is
the affordance people try first and the only non-drag path through them.

**The armed strip is a fixed two lines.** Its text changes constantly while a move is being
aimed; if its height changed with it, `--sheet-rest` would change, `.board-pane` would
re-inset, and the whole board would rescale under a finger that is mid-drag.

## The board

`src/ui/Board.tsx`, with all the viewport maths in the pure, unit-tested `src/ui/boardView.ts`.

**The window is aspect-locked to the PANE, not to the killzone.** A 30×22 board drawn at its
own aspect into a portrait phone letterboxes to a 390×286 strip with ~400px of dead black; the
pane lock means the board fills what it is given and you pan along the long axis.

| Framing | What it is |
| --- | --- |
| `fillViewport` | the resting window: board against the pane's short side, long axis cropped |
| `fitViewport` | the whole killzone, bars accepted — what the ⤢ control does |
| `frameRect(rect)` | point the camera at a world rectangle, capped at fill so a framing request can never letterbox |

`plan.frame` is how deployment shows your drop zone and an activation shows where an operative
can go. The player never has to find the relevant inch.

Rules the gesture layer keeps:

- **A second finger cancels whatever the first was doing**, and any press that wanders more
  than 8px swallows its trailing `click` — a pinch or a pan can never place an operative.
- **While the board is armed, one finger aims and two fingers pan.** The ghost rides 46px above
  the finger, because a 32mm base is smaller than a fingertip.
- A base is drawn **true to scale** (control range is measured off it) but hit at **thumb
  size**: an invisible disc gives every operative at least a 44px target, and the letter is
  drawn at a constant 13px however far you zoom.
- The zoom cluster floats on one side for the whole battle, chosen from the KILLZONE's drop
  zones (whose edge they crowd less), never from the current screen's framing. It used to be
  derived per screen and hopped corners between deploy and activate — a control that moves is
  a control you re-find every time (D-055).
- **One finger aims, one mouse pans.** A finger drags a ghost whenever a base is armed; a
  mouse gets the desktop idiom instead — hover previews the ghost, drag pans, click commits —
  because a mouse has exactly one pointer and would otherwise be unable to pan at all on the
  deploy and move screens (D-052). An arm with a `commit` but no `base` (the drop-zone picker,
  the shooting screen's tap-swallower) draws no ghost and keeps its pan.
- `variant="thumb"` boards (the 24 killzone-browser previews) stay inert.

### Deployment

The complaint this exists to answer. The board *is* the screen:

1. It is already aimed at the deploying player's drop zone; everything outside it is masked out
   at 62%, the zone itself stroked in that player's colour.
2. The next operative is auto-armed and named in the sheet — placing three is three taps, not
   three round trips through a list.
3. A drag shows a ghost of the operative's **real base**, tinted by
   `canDeployAt` — the reducer's own legality body, exported, so the ghost's answer and its
   wording are the intent's.
4. A refused tap surfaces the reducer's sentence as a toast: *"operatives must be set up wholly
   within your drop zone"*. The old build discarded it, which is why a tap that did nothing
   looked like a broken app.
5. **Undo** takes back a placement. Undo is empirical, not declarative: the store snapshots
   before every intent and offers the undo only if the RNG cursor and the roll journal are
   unchanged across it, because `Reposition` rolls a D3 on a mine and `Breach` rolls a D6.

### Equipment set-up

Between the reveal and deployment, if either player bought equipment that occupies space on the
killzone. Same shape as deployment — the board is the screen, the item is auto-armed, the ghost
is its real footprint — with one difference that matters:

**Where an item may go is asked of the engine, cell by cell, not approximated by the drop
zone.** Every option carries its own constraints, so the screen samples
`validateEquipmentPlacement` on a 0.75" grid and shades the cells that pass (D-051). There is
always a way out (*"Set up no more equipment"*), because an item can legitimately have nowhere
legal to go and the battle must not be strandable on this screen.

### End of a turning point

Scoring is the one thing that happens with nobody touching the screen, so the game now stops on
it (D-049) and shows what each side scored, in the ops' own words, read out of the log. Before
this the phase was overwritten inside the same reducer call and the screen was unreachable: up
to 6VP a side simply appeared in the top bar during the next initiative roll.

### Shooting

The target list is on screen (`half`, not `rest` — the screen's own help says "or pick one
from the list"), and the board is framed on the shooter **and everything it can shoot**. A
square around the shooter alone put every target off screen: a screen headed "Pick a target",
showing no targets, over a board full of your own operatives.

### Movement

`PerformAction` needs a `MovePath`, and the old action sheet dispatched Reposition/Dash/Charge
with no params — every move was rejected, so the app could not play a game of Kill Team.

A move is aimed on the board: `reachableCells` shades where the operative can get to,
`moveBudget` sets the allowance, the path is drawn, and `validateMove` — the same call the
reducer will make — decides whether Confirm is live. The readout shows both numbers, because
`MoveValidation.total` is the *charged* distance (each leg rounds up to the inch) and showing
only that reads as a bug: `4.2" — costs 5 of 6"`.

The shaded field is advisory. The authoritative answer is `validateMove` at the ghost position,
which also enforces the end-position rules the flood fill does not evaluate.

## What the UI may read from the core

Any function exported from `src/core/**` that takes `(ctx, state, …)` and returns without
mutating. It may never re-implement one. Where the answer was not exported, it was added:

| Selector | Why |
| --- | --- |
| `canDeployAt` | the ghost gets the reducer's own verdict, in the same words, without cloning GameState per frame |
| `actionAvailability` | `availableActions` never runs `def.check`, so a menu built from it offers actions the reducer will reject |
| `deployToAct` / `deployBatchRemaining` | alternating deployment in thirds is a printed RULE the reducer does not enforce; deriving it in the UI meant nothing tested it |
| `gambitToAct` | same, for gambit alternation |

## Roster builder

`src/ui/roster/` — Core Rules › SELECT OPERATIVES. The same component in both places: the
menu's workbench passes no `onConfirm`, the setup step passes one.

**Why it is laid out the way it is.** The owner's report was "selecting operatives moves things
around weirdly", and it was exactly right. The old screen put the growing list of picked
operatives, a growing list of validation errors and a sticky status bar *above* the catalogue,
so every tap on a `+` grew the page above the thumb; and every row that became unaddable
sprouted a red two-line reason, which changed that row's height too. Three reflows per tap.

In order down the screen, never rearranged:

```
status   pinned, fixed height — the counts, and ONE line of what is still missing
body     the ONLY scroller: the catalogue first, then everything that changes size
tray     pinned, fixed height — the picks so far, and the confirm button
```

A catalogue row's height is fixed by its grid: the count badge and the add button live in a
constant-width column, and the reason a row is unavailable is one truncated line that is
*always* rendered. `e2e/smoke.spec.ts` asserts the invariant directly — tap the `+` nearest the
middle of the scroller, re-read its `boundingBox().y`, and require `|Δy| ≤ 1`.

**One validator, no second opinion.** Legality is decided only by `validateRosterFor`
(`src/teams/selection.ts`), driven by the `selection` block of `data/teams/<slug>.json`:

| Screen affordance | How it is decided |
| --- | --- |
| `＋` live / disabled | a trial validation of `picks + this entry`; the disabled reason is the validator's own sentence |
| slot chips (`1/1 leader`, `9/9 selections`, `group 2: 9/9`) | `usage()` in `rules.ts` — pure counting over `selectionCost` |
| the violation list | `validation.errors`, each quoting the rule that produced it |
| confirm enabled | `validation.ok` — an illegal kill team can never reach `SelectRoster` |

**Loadouts.** Every `loadouts` / `optionGroups` / `fixedChoiceGroups` row becomes a select on
the operative's card. Weapons no selection option names are listed with an "always carried" tag
rather than as a choice — **including `Limited x` weapons**. The resolved names ride along on
the `SelectRoster` intent and are recorded with `selection.applyLoadouts`.

**Warnings, never silence.** Printed constraints the shared validator cannot express
(docs/TEAM-DATA.md §5) are listed under "⚠ N rules this app does not check", verbatim. Six
teams go further — their printed list cannot satisfy the validator's slot arithmetic at all;
`supportProblems()` detects that from the data, flags the team in the picker, and the confirm
button says "legality not enforced" for those teams only.

**Persistence.** Named rosters live in `localStorage` under `kt24.rosters.v1`, with JSON
import/export of `{format: "kill-team-mobile/rosters@1", rosters: [...]}`. A saved roster is
`teamId` + `RosterPick[]`, i.e. exactly what `SelectRoster` wants.

## Visual system

Tokens in `src/ui/styles.css`. Every value below was contrast-checked against the surface it
sits on; the three marked **fixed** were measured failures in the previous palette.

| Token | Value | Note |
| --- | --- | --- |
| `--bg` / `--surface` / `--surface-2` / `--surface-3` | `#0b0d11` … `#262d38` | |
| `--ink` / `--ink-2` / `--ink-3` | `#eef1f5` / `#bac4d2` / `#98a3b3` | ≥ 5.4:1 on every surface |
| `--line` / `--line-strong` | `#6a7787` / `#8a96a6` | **fixed** — the old `#2f3743` was **1.33:1** on `--surface-2`, i.e. every control border in the app was invisible (WCAG 1.4.11 wants 3:1) |
| `--p1` / `--p2` | `#f2751f` / `#cfe8fa` | **fixed** — the old pair was **1.00:1** in luminance, so friend and enemy were the same token in greyscale and to a red-green colour-blind player. 2.26:1 apart, and p2 carries a second ring so the difference survives monochrome |
| terrain fills | `#5e6774` … `#5b8fa8` | **fixed** — the old Wall was **1.17:1** on the board and was then multiplied by a `0.55 + z1*0.08` opacity ramp. Height now reads from the outline weight |
| `--accent` / `--ok` / `--danger` / `--focus` | `#ffc94a` / `#5fd08a` / `#ff7a6b` / `#8fd3f5` | |

- **13px is the type floor.** The old 10px stat keys and 11px tags were unreadable at arm's
  length on a table.
- **Disabled is a colour, not an opacity veil.** `opacity: .45` dropped a bordered icon
  button's stroke to ~1:1 against its own fill.
- **An illegal control shows its reason in the row.** `title` does not exist on a touch screen.
- Conceal is a dashed outline, expended is a strike-through, selected is a white ring — none of
  them a lone alpha delta.
- Icons are 24×24 inline SVG strokes in `currentColor` (`src/ui/icons.tsx`). The emoji they
  replaced rendered in the vendor's colours, could not take an accent or a disabled state, and
  leaked into accessible names ("crossed swords A").
- **No ambient animation.** A killzone that breathes for a whole battle is noise and a
  vestibular trigger. Pulsing is reserved for a target the player is being asked to tap.
- `prefers-reduced-motion` disables every animation and transition.

## Accessibility

- Two live regions mounted once at boot and never unmounted: `role="status"` announces the
  current prompt and the armed state, `role="log"` the battle log.
- 44px is the floor for every control; the primary action is 52px.
- Colour is never the only signal: dice carry pip faces and `aria-label`s, operatives carry
  letters and shapes, terrain carries `<title>` with its types and heights.
- `index.html` no longer sets `maximum-scale=1, user-scalable=no` — that fails WCAG 1.4.4 and
  is honoured by every Android browser and every iOS in-app WKWebView. The double-tap zoom it
  was there to stop is handled by `touch-action` instead.
- Chrome takes the landscape safe-area insets (`env(safe-area-inset-left/right)`); the board
  runs full-bleed under the cutout, which is the point of `viewport-fit=cover`.

## Dice

`src/ui/dice/Dice.tsx`. Dice are drawn **inside the board's world transform**, so a pool sits
above its operative and follows pan and zoom. Each `Die` keeps its `id` for the whole sequence,
so a re-roll animates only the dice that were re-rolled and shows `↻4`; retained / discarded /
blocked / struck are visually distinct; Accurate's auto-successes render as unrolled ✓ dice.

## Reactive windows

`decisionPlan` renders the generic case — the prompt, the printed rule text, and one obvious
default the engine marks `auto`/`keep`. Two things are not generic:

- **Defence allocation** gets a screen of its own (`command/allocate.tsx`). Its running damage
  total and the button that commits it live in the PEEK, and the tapped-so-far allocation
  lives in `UiState` rather than inside the component, because on a phone both sat below the
  fold of the sheet's scrolling body — on the screen that decides how much damage an operative
  takes. The rules give the
  defender a real choice here and the first build shipped an "Allocate manually" button that
  ran the automatic allocation, because only the `auto` option carried any data (D-053). It now
  shows the incoming hits as chips: tap one to save against it, the allocator spends the
  cheapest legal defence dice and refuses what cannot be paid for, and the damage total updates
  before anything is committed.
- **The handover.** In a match the phone is assumed to be with whoever is acting
  (`deviceHolder`), so a reactive window belonging to the other player asks for it by name
  first, and hands it back on resolve (D-054). Sandbox mode skips this entirely — one person
  driving both sides does not want to confirm a handover every time a save is rolled.

## Screenshots

`docs/ui-review/` holds a captured pass over the whole flow at three viewports (phone portrait,
phone landscape, desktop), regenerated by driving the app with Playwright. They are the input to
a visual review, not fixtures.

The capture plays a real battle: it deploys by tapping the highlighted drop zone, sets equipment
up, walks operatives toward the middle and fires the weapon with the most targets — which is
what reaches the screens that only open because somebody pulled a trigger (the target list, the
defence allocator, a re-roll window, an obscured discard, a mid-battle handover). Every screen
in the numbered sequence below is a state the app actually reached, with zero console errors on
all three viewports.

## The `half` detent on a short screen

`half` means "the option list for the current step, with the board still readable", so it is a
fraction of the stage — but the peek above it does not scale: the prompt is what it is, and the
armed banner is deliberately a fixed 52px (see `.armed-banner`, which must not change height
mid-drag). On a 568px iPhone SE, 52% left 106px for a help paragraph, a section title and the
first row, and the first row the screen tells you to tap ended 3px below the fold. Below 560px
of stage the sheet takes 68% instead.

## Known gaps

- No pre-battle screen: the app boots straight into a battle on the first killzone. Choosing a
  killzone and a crit op is behind the menu, and `state.critOpId` is unset by default, so no
  crit op scores.
- Waypoints: a move is a single straight leg to the ghost. A path around a corner has to be
  taken in two actions.
- Dice are sized in world inches, so they shrink with the zoom instead of staying a constant
  size on screen.
- A `frame: 'fit'` screen at the `half` detent (the end of a turning point, the result) shows
  the letterbox bar above the board and hides the one below it behind the sheet, so the board
  sits high with dead space over it. Fit is honest about its bars; aligning them to the visible
  part of the pane would need the Board to know the sheet's *current* height rather than its
  resting one, which is exactly the coupling `--sheet-rest` exists to avoid.
- The floating zoom cluster sits over one drop zone on maps whose zones run up both edges. It
  is stable per killzone (D-055) rather than dodging per screen, and a mis-tap only changes the
  view — but on those maps it does overlap inches you may want to place in.
- No autosave: a reload loses the battle. `Store.exportReplay()` already emits
  `{ seed, mapId, critOpId, intents[] }`, which is what a restore would replay.
- Choosing a loadout records the operative's weapons in `state.opState.loadout`, but
  `weaponsOf` does not read it yet — an operative still fights with every weapon on its
  datacard.
