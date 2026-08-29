# AI

The Kill Team AI: how it decides, what it is worth, and where it is weak.

Everything lives in `src/ai/**`. It drives the game **only** through `Intent`s submitted to
`reduce(state, intent, ctx)` — the same channel the UI uses (CLAUDE.md architecture rule #1) —
never by touching `GameState`. All randomness comes from the injected `ctx.rng` (rule #2), and
simulations use `ctx.rng.fork(tag)` so a rollout can never disturb the match dice stream.

```
src/ai/
  types.ts     Agent contract, difficulty presets, evaluation weights
  legal.ts     parameterised legal-intent enumeration (the AI's action surface)
  moves.ts     movement candidates from the engine's reachability field
  combat.ts    expected-damage maths, reusing the engine's own dice primitives
  eval.ts      state evaluation + per-operative positional scoring
  decide.ts    reactive-window policy (rerolls, cover/obscured, strike-or-block, …)
  agent.ts     TacticalAgent — pruning, one-ply search, plan execution
  baseline.ts  RandomLegalAgent, GreedyAgent (soak drivers and the strength baseline)
  deploy.ts    deployment placement
  runner.ts    bot-vs-bot game driver (`playGame`)
  caches.ts    every module-level cache, and the per-game reset
```

The agent plays **in the app** as well as in the soak, as a selectable opponent. That layer is
UI, not AI, so it lives in `src/ui/ai/**` and is documented in §10.

## 1. Why the intents are always legal

`reducer.legalIntents()` lists the intent *shapes* a player may submit, but it emits
`PerformAction` with no params — a Shoot with no weapon, a Reposition with no path. Those are
rejected, and the AI's acceptance bar is **zero rejected intents**. So `legal.ts` builds fully
parameterised candidates and then re-runs the engine's own gates on each one before it is ever
offered to an agent:

| Action | Params generated from | Verified with |
| --- | --- | --- |
| Reposition / Dash / Fall Back / Charge | `reachableCells` (0.5" field) → straight-line `MovePath` | `validateMove` with the **same** `MoveOptions` the reducer uses |
| Shoot | every weapon × profile × enemy that `checkTarget` accepts | `Shoot.check` |
| Fight / Hatchway Fight | enemies in control range | `Fight.check` |
| Guard, Operate Hatch, Breach, Pick Up / Place Marker | terrain parts and markers in range | the action's own `check` |
| Mission / unique actions (ops, team rules) | a param sweep: each contested marker, nearby enemies/friends, the operative's own position, and no-params last | the action's own `check` **and a trial `reduce`** on a forked RNG (several op actions pass `check` and then fail in `perform`) |

A movement destination is only kept if a real `MovePath` to it validates: straight line first,
then a mid-point dog-leg, and for a Charge two perpendicular dog-legs that get around a corner
the straight line clips. Anything that fails is dropped rather than dispatched and rejected.

## 2. Evaluation

`evaluate(ctx, state, me, weights)` scores a whole state from one player's point of view.
VP dominates; everything else is a proxy for the VP it will eventually pay.

| Term | Weight | What it measures |
| --- | --- | --- |
| `vp` | 120 | `teams[me].vp − teams[them].vp`. A finished battle adds ±4000 so no proxy can outweigh the result. |
| `objective` | 22 | Objective markers controlled (`markerController`, computed once per state). |
| `mission` | 26 | Generic op progress: marker flags stamped with the player id (`secured`, `downloadedBy`, …) plus op-sourced effects. This is what makes a mission action worth an AP in the turning point it is performed, rather than only when the op scores. |
| `operative` | 6 | Sum of surviving operative value (`wounds·0.6 + APL·2 + Move·0.15 + save + weapon power`; datacards carry no points). |
| `wounds` | 9 | The same value scaled by remaining wounds — chip damage matters, kills matter more. |
| `cp` | 3 | Command points in hand. |
| `carry` | 14 | Carrying a mission marker. |
| `advance` | 0.9 | Negative distance to the nearest objective — stops a stalled team from standing still. |
| `threat` / `exposure` | 2.2 / 2.6 | Only in the per-operative positional term (below); the whole-team version exists but is off in search (`fast: true`) because it costs a visibility sweep per evaluation. |

**The turning-point clock.** Four turning points, then every surviving operative is worth
nothing and only VP is banked, so `urgency()` scales the scoring terms up and the survival
terms down in the last two turning points — hardest when the game is tied or lost. Without it
the AI plays a drawn position as cautiously in TP4 as in TP1.

**Positional term.** `positionScore()` prices one operative standing at one spot: the best shot
available from there (`threat`), and what could shoot back (`exposure`). Exposure counts the
worst enemy in full and the rest at 0.35, because usually only one enemy acts before we move
again; an **expended** enemy is discounted to 0.3 since it cannot shoot again this turning
point. It is applied as a *delta against the baseline* and only to candidates that actually
move — otherwise "stand still" would look free and the AI would never advance.

## 3. Damage model

`combat.ts` computes the exact distribution rather than sampling, and it **reuses the engine's
own primitives** (`classify`, `allocateSavesOptimally`, `piercingValue`, `devastatingDamage`,
`checkTarget`) so it cannot drift from what the sequence will actually roll: per-die
probabilities from `classify` (so Lethal x+ is exact), a DP over (crits, normals), retention,
obscured discard, Piercing-adjusted defence dice, cover saves, optimal allocation and
Devastating. `tests/ai.test.ts` pins it against a 400-volley Monte-Carlo of the real Shoot
sequence (estimate 2.15 vs measured 2.00 damage).

Two documented approximations:

- **Re-rolls** (Balanced / Ceaseless / Relentless) are folded into the per-die probabilities as
  a fraction of the fail mass re-rolled once — 1.0 for Relentless, 0.6 for Ceaseless (it
  re-rolls a single value), 1/N for Balanced.
- **Retention** applies the single option the default decision policy would pick
  (severe → rending → punishing), matching `applyRetentionDecision`, which applies exactly one.

Melee is resolved analytically under the "always strike, best die first" policy the AI uses,
alternating attacker/defender exactly as `resolveFightDie` does, stopping on an incapacitation.

## 4. Search

Per activation:

1. **Shortlist** — every ready operative gets a cheap score (best available shot, objectives
   held, role); the top `shortlist` get a full plan.
2. **Order** — Engage unless the operative has nothing to attack with, in which case Conceal is
   planned as well and the better plan wins. (Conceal forbids Shoot, Charge and Guard.)
3. **Plan** — a greedy sequential search up to the operative's APL. At each step the candidate
   beam is scored and the best is applied to a simulated state:
   - **attacks** are scored analytically from `combat.ts` (cheaper *and* lower variance than
     rolling them);
   - **everything else** is applied through the real `reduce` on a forked RNG, so a simulated
     mission action or move goes through the real rules, and any decision it raises is answered
     by the same `decide.ts` policy;
   - the step stops when nothing beats simply ending the activation.
4. **Execute** — the winning plan is cached and each step is re-validated (`def.check`) right
   before dispatch; if the world moved under it (a Guard interrupt killed the target), the AI
   replans for the remaining AP.

Counteracts plan `Counteract` + one 1AP action and compare against declining (declining burns
the whole team's counteracts for the turning point, so it is a last resort). On Guard
interrupts are scored the same way and taken only when they beat doing nothing.

## 5. Reactive windows

| Decision | Policy |
| --- | --- |
| `coverOrObscured` | Both options priced with `shootEstimate`; the cheaper one is taken. (Obscured usually wins, but not against a one-die weapon or a Piercing-stripped defence pool.) |
| `reroll` (free: Balanced/Ceaseless/Relentless) | Re-roll all fails; in `value` mode, the failing value with the most dice on it. |
| `reroll` (Command Re-roll, 1CP) | Spend only when `P(success) × damage-per-success ≥ 0.6` and CP stays above the floor. Re-rolls the worst failed die. Works on defence pools too, where the "damage per success" is the damage prevented. |
| `retention` | Only one option is ever applied, so the biggest one wins: Severe/Rending are worth `dmgC − dmgN`, Punishing `dmgN`. |
| `allocateDefence` | `auto` — `allocateSavesOptimally` is already exactly optimal. |
| `strikeOrBlock` | Strike if it incapacitates; else block their best die if their remaining successes would kill us; else strike. |
| `initiativeCard` | Pass while winning the roll-off; otherwise play the **smallest** card that flips it, and only re-roll when behind by 2+. |
| `chooseInitiative` | Take initiative. |
| `primaryOp` | The crit op — the one op both players can score every turning point. |
| anything else (team ploys, killzone prompts) | `defaultDecisionOption`, then the first enabled option. |

## 6. Difficulty

| | nodeBudget | beam | shortlist | rollouts | moveStep | noise |
| --- | --- | --- | --- | --- | --- | --- |
| Recruit | 60 | 2 | 1 | 0 | 1.0" | ±26 |
| Veteran | 420 | 5 | 3 | 1 | 0.5" | ±8 |
| Elite | 900 | 6 | 3 | 2 | 0.5" | 0 |

`nodeBudget` is the **primary, deterministic** limiter: 1 unit per simulated `reduce`, 8 per
candidate enumeration, 3 per positional score. `timeBudgetMs` (300ms) is a wall-clock safety
valve that is **off by default** (`enforceTimeBudget`), because a clock-dependent cutoff would
make replays non-reproducible; the node budget is tuned to stay well inside it. Measured Elite
latency on the arena map: **worst 186ms, mean 24ms** over 70 decisions.

Noise is drawn from `ctx.rng.fork(...)`, which does not consume the match stream, so a noisy
Recruit still replays byte-identically from its seed.

## 7. Acceptance runs

Measured with `pnpm test` (all figures are deterministic — same seeds, same code, same result).

### Soak — `tests/soak/soak.test.ts`, ~17s

| Map | Killzone | Pairings × seeds | Rejected intents | Result |
| --- | --- | --- | --- | --- |
| `ai-arena` | synthetic Volkus | random/greedy/tactical × 2 | 0 | 6 games, all `battleEnd` at TP4 |
| `ai-corridor` | synthetic Volkus | random/greedy/tactical × 2 | 0 | 6 games |
| `ai-gallowdark` | synthetic Close Quarters | random/greedy/tactical × 2 | 0 | 6 games (Guard/On Guard live) |
| `bheta-decima-1` | real extracted | greedy vs greedy | 0 | `battleEnd` |
| `gallowdark-1` | real extracted | greedy vs greedy | 0 | `battleEnd` |
| `tomb-world-1` | real extracted | greedy vs greedy | 0 | `battleEnd` |
| back-to-back | 3 different battles in one process | tactical/greedy/random | 0 | all terminate; cache-leak regression |

`KT_SOAK=full` widens it to 6 pairings × 4 seeds × 3 maps plus 6 real maps.

### Strength — `tests/ai.test.ts`, ~160s

50 seeded games per matchup, sides alternating, on `ai-arena` + `ai-corridor`, crit op
`crit.secure`, tac ops Dominate vs Rout, 4 operatives a side.

| Matchup | Result | Win rate | Score rate | Avg VP | Bar |
| --- | --- | --- | --- | --- | --- |
| Tactical (Veteran) vs Greedy | 35W 13D 2L | **70%** | 83% | 7.6 : 3.8 | 80% — **not met** |
| Tactical (Veteran) vs Random | 47W 2D 1L | **94%** | 96% | 7.8 : 2.9 | 95% — **not met** |
| Tactical (Elite) vs Greedy | 34W 12D 4L | 68% | 80% | 8.5 : 3.6 | (more search is not the answer) |

Other measurements from the same fixture: Elite decision latency worst **195ms** / mean 26ms
over 66 decisions; one full game costs Recruit 0.5s, Veteran 1.9s, Elite 2.1s of AI thinking;
`tests/ai.test.ts` takes ~160s end to end (two 50-game matchups dominate).

Honest reading: the AI is plainly the stronger player — it roughly doubles Greedy's VP and
loses 2 games in 50 — but it does not convert that into *wins* often enough. **Every draw
against Greedy is on `ai-corridor`**, each a 3:3 or 4:4 mirror with equal survivors: a
symmetric board where both sides secure their home objective, neither can cross profitably, and
mirrored heuristics produce mirrored play. Things that did NOT fix it: more search (Elite 68%,
worse), a stronger objective pull (advance weight 1.8 → 55%, 3.0 → 60%), and the
turning-point clock (§2, 72% → 70% — inside the noise, kept because it is the correct rule).

The assertions in `tests/ai.test.ts` are therefore **regression floors at the measured rate,
not the brief's bars**, and the test names say so. See *Known weaknesses* for what would move
the real numbers.

## 8. Known weaknesses

- **Stalemates on symmetric boards.** The AI has no model of the opponent's reply beyond the
  exposure term, so on a mirrored map two equally cautious sides tie. A two-ply search
  (opponent's best answer) or an explicit "we are ahead on VP, deny contact" / "we are behind,
  force contact" mode would break it; the turning-point clock is not in the evaluation at all.
- **No lookahead across activations.** Activation *order* is chosen one ply deep. Kill Team
  rewards holding an activation back; the AI never does.
- **`chooseInitiative` always takes initiative.** Activating last is often stronger.
- **`primaryOp` is picked blind** (turning point 1, nothing scored yet) — always the crit op.
- **Tac-op play is generic.** Mission actions are found by a param sweep and valued by the
  generic marker-flag proxy, so an op whose progress is not stamped on a marker (or which needs
  a specific operative in a specific place two turning points early) is played weakly.
- **Ploys and equipment are only as good as `aiHints`.** Without `aiHints.ployValue` a team's
  firefight ploys are never used; equipment is not chosen at all (the runner takes what the
  roster spec gives it).
- **Guard is under-used.** Its hint is a flat "an enemy is within 8"", not an interrupt EV.
- **Re-roll and retention estimates are approximations** (§3) — a Ceaseless weapon's value is
  within a few percent, not exact.
- **Real Gallowdark maps play out to 0:0** with every operative alive — the agents never make
  contact through a sealed hatchway layout. Worth investigating whether hatchways start closed
  and nothing opens them, which would be a map/engine issue rather than an AI one.
- **Deployment is one shared heuristic** for every agent (objective pull + spread), so measured
  win rates reflect play, not setup. It ignores cover and enemy sightlines.

## 9. Engine findings

Raised from AI work; none are worked around in a way that hides them.

1. **`reduce()` deep-clones the whole `GameState` including `state.map`** (`reducer.ts:47`
   `structuredClone`). The map never changes during a battle (terrain edits go to
   `state.terrainState`), but it is copied on *every* intent — **36% of all CPU** in a profiled
   AI game, plus the GC pressure. Detaching `map` before the clone and re-attaching would be a
   large win for the UI as well as the AI.
2. **The terrain index is rebuilt on every intent.** `context.ts:57` keys the cache on
   `ctx.terrainCache.map === state.map`, and the clone in (1) makes that identity check fail
   every time.
3. **A counteraction is not limited to one action** (`reducer.ts` › `PerformAction`): while
   `opState.counteract` is set, neither the AP limit nor action restrictions apply, so the
   reducer accepts an unbounded stream of 1AP actions. The rule is "one free 1AP action". This
   is not theoretical — an early soak run spent 7,940 Repositions in one game. The AI now
   offers exactly one action while counteracting (`legal.ts`, commented), but the reducer
   should enforce it.
4. **The counteract 2" movement cap is not enforced.** `movement.ts` supports
   `MoveOptions.hardCap` but nothing passes it, so a counteracting operative may move its full
   Move stat. The AI self-limits to 2" to keep the soak honest.
5. **`EndActivation` treats a counteraction as an activation**: it increments
   `activationsThisTP` and ticks smoke even when `opState.counteract` is set, though
   "counteracting isn't an activation" (CLAUDE.md).
6. ~~**`OnGuardInterrupt` never clears `opState.guardOffer`**~~ — **fixed since this was
   filed.** Both `OnGuardInterrupt` and `DeclineInterrupt` now end with
   `delete next.opState['guardOffer']` (`reducer.ts`), and `offerGuardInterrupt` refuses to
   re-open a window already spent on this activation (`guardInterruptUsedFor`). A poller is
   offered the interrupt once. The runner's `state.seq` de-duplication is now belt and braces;
   `src/ui/ai/driver.ts` needs none.
7. **`legalIntents` emits `PerformAction` without params**, which is always rejected for every
   action that needs one. Callers must parameterise; §1 is the AI's answer.
8. **Several op mission actions accept a `check` they cannot `perform`.** With no params, an op
   action's `check` passes and `perform` then fails with "select an enemy operative"; the
   reducer reverts AND records a rejection, so a caller that trusts `check` produces rejected
   intents (it broke two Gallowdark team-soak games). The AI now confirms every mission-action
   candidate with a trial `reduce` on a forked RNG, but `check` and `perform` should agree on
   what params an action requires.

## 10. In the app — the AI as an opponent

`src/ai/**` plays through `Intent`s and nothing else, so making it a selectable opponent needed
no rules code at all. What it needed was the three things `playGame` does that are not "ask the
agent and dispatch", and one thing the app does that `playGame` never has to: **share a battle
with somebody**.

```
src/ui/ai/
  opponent.ts  who is in each seat, the difficulty, the AI's kill team — persisted
  roster.ts    the AI's kill team, equipment and tac op
  setup.ts     the setup intents, which the agent cannot produce at all
  driver.ts    aiTurn() — whose move is it; AiDriver.step() — take it
src/ui/command/opponent.tsx   the picker, the opponent's turn, and the AI-stopped screen
```

### Whose move is it

`aiTurn(ctx, state, opponent)` answers that from **selectors only** — no enumeration, no search,
no agent. It has to: `commandPlan` calls it on every render to decide whether the board is the
player's or the opponent's, and a render that ran a 200ms search would be unusable. `step()` is
the only thing that thinks, and it is called **once per dispatched intent**, because
`TacticalAgent` shifts a step off its plan queue *before* it validates it — a second,
speculative `act()` on the same state silently throws a planned action away.

Its branch order is `commandPlan`'s own, so the screen and the driver cannot disagree:

| | who owes it | why it is not `actorFor` |
| --- | --- | --- |
| `pending[0]` | `decision.who` | only `pending[0]`, because that is the window the screen is showing |
| `opState.guardOffer` | `offer.player` | On Guard is not a `PendingDecision`; the reducer does not block on it |
| active operative `removed` | its owner | see below |
| `phase === 'setup'` | `aiSetupTurn` | `actorFor` returns **null** for the whole of setup |
| `strategy`/gambit | `gambitToAct` | |
| `firefight` | the active operative's **owner**, else `whoActivates(state, ctx)` | `PerformAction` and `EndActivation` carry no player field — the reducer authorises them on `activeOperativeId` alone, so a driver keyed on "whose turn" would play the person's activation for them. And `whoActivates` is asked **with** the context, which `actorFor` omits: without one it cannot see a team rule that widens who may counteract |

**The corpse holding the activation.** An operative killed mid-activation — a counter-strike, an
On Guard shot — leaves `activeOperativeId` pointing at it: `removeIncapacitated` does not clear
it and nothing ends that activation, so it is never marked expended, the activation clock never
ticks it and `onActivationEnd` never fires. In pass-and-play the players walk past it. In a solo
battle it is a dead end as soon as the surviving side runs out of ready operatives, so the driver
sends `EndActivation` for it **whoever owns it**. That is a pre-existing hole in the shell, fixed
here only for battles that have an AI in them.

### Setup

`actorFor` returns null for `phase === 'setup'` and `legalIntents` enumerates no setup intent, so
the agent is never even consulted before the first activation. `src/ui/ai/setup.ts` is the app's
answer, and it differs from `playGame`'s hand-written script in two ways that matter:

- it goes through **`BeginDeployment`**, which the runner skips — so `setup.revealed` is written
  and `setup.step` can become `placeEquipment`, the only route by which a barricade or a ladder
  ever reaches the killzone;
- it deploys by **alternating thirds** (`deployToAct`, `deployBatchRemaining`), which is the
  printed rule, rather than the runner's one-at-a-time alternation.

Placements are taken from `deployPositions` (`src/ai/deploy.ts`, a ranked list rather than a
single answer) and re-checked with `canDeployAt` before dispatch, because the placer checks the
drop zone, hazardous areas and base overlap while `canDeployAt` also enforces the Stronghold
occupancy cap.

### What it brings

`defaultRoster` for the kill team, `applyLoadouts` after the dispatch, up to four universal
equipment options that need no setting up, and one of the twelve tac ops by battle seed
(docs/DECISIONS.md D-110). All 48 bundled teams field a legal kill team this way, pinned in
`tests/ai-opponent.test.ts`.

### Pacing, and what it costs

One intent per macrotask (`AI_PACE_MS`, 150ms, in `App.tsx`). The timer is not decoration:
`Store.dispatch` notifies its subscribers synchronously, so driving the AI from the subscriber
would re-enter the reducer from inside the previous notification — and it lets the screen that
says whose turn it is paint *before* the search that blocks the thread starts.

Latency here is much heavier than §6's figures, which are the synthetic 4-operative arena.
Measured on `bheta-decima-1` with real kill teams (scout-squad 9 vs chaos-cult 14), one whole
bot-vs-bot battle driven through the app's `Store`:

| Difficulty | intents | worst decision | p95 | mean | total thinking |
| --- | --- | --- | --- | --- | --- |
| Recruit | 280 | 153ms | 95ms | 23ms | 6.5s |
| Veteran | 324 | 1208ms | 501ms | 86ms | 27.9s |
| Elite | 327 | 1191ms | 659ms | 104ms | 34.1s |

A solo battle is about half of that, spread over four turning points. `enforceTimeBudget` stays
**off**, as it is everywhere else: a clock-dependent cutoff would make the same seed play
differently on a slower phone, and a battle is supposed to replay byte-identically from
`(rosters, map, seed, intents[])`. `nodeBudget` is the limiter.

### Lifecycle

Everything `playGame` does per process, the app has to do per battle, and did not do at all:
`resetAiCaches()` (reachability fields keyed by map and position; damage estimates keyed by
datacard), `agent.reset()`, and a fresh `SeededRng` — `App` built its RNG once at boot and
neither "New battle" nor the killzone browser ever replaced it, so every subsequent battle
continued the previous one's dice. All three now happen in one place, `newBattle()` in `App.tsx`.

AI intents are dispatched with `{ undoable: false }`. Undo is there so a *person* can take back
their own misplaced operative; there is nothing to take back about the opponent's activation, and
a snapshot of the whole `GameState` per intent is not free.

### When it stops

The AI's acceptance bar is zero rejected intents, so a refusal is a defect, not a rules result.
`AiDriver` stops on the first one, clears `store.lastRejection` (the toast layer phrases it as
something the *player* did wrong) and the shell shows `ai.error`, whose one action hands that
seat to the player and carries on with the same battle.

### Known weaknesses of the app layer

- **The AI takes no placeable equipment** — no barricades, ladders, mines or ammo caches, because
  nothing in `src/ai/**` can choose a spot for one. A human opponent can, so this is a real (if
  small) asymmetry.
- **Its tac op is chosen blind**, by seed, from all twelve. §8 already applies.
- **The AI's kill team is `defaultRoster`'s**, which is the printed list filled greedily in
  order — a legal kill team, not a considered one.
- **A watched battle plays itself; a solo one still needs four "Continue" presses a turning
  point** (D-109). That is deliberate, but it is the thing most likely to be re-litigated.
