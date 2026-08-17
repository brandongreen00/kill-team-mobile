# Ops, initiative cards and universal equipment

Phase 3 of the overhaul: the nine Approved Ops crit ops, the twelve tac ops, the kill op, the
primary op, the initiative cards, and the eleven universal equipment options.

- Printed text + parameters: `data/ops/{crit-ops,tac-ops,kill-op,initiative-cards}.json`,
  `data/equipment/universal.json` (verbatim from the Approved Ops 2025 card pack and the
  Universal Equipment supplement; ids and flags are ours).
- Mechanics: `src/core/ops/**` (one module per op) and `src/core/equipment/**`.
- Tests: `tests/ops.test.ts` (31), `tests/equipment.test.ts` (17). Every test quotes its rule.

## How it fits together

| Piece | Where |
| --- | --- |
| Registry | `ALL_OPS` (22 = 9 crit + 12 tac + kill), `opsMap()` for `makeContext({ ops })` |
| Scoring | `scoreEndOfTurningPoint(ctx, state)` and `scoreEndOfBattle(ctx, state)` — both idempotent |
| Battle setup | `initOps(ctx, state)` — Orb token, Reboot numbering, Energy Cells' pick-up flag |
| Secret choices | `PendingDecision` + `resolveOpDecision(ctx, state, decisionId, optionId, data?)` |
| Mission actions | `registerAction` at import time, each gated by `available()` on the op in play |
| Kill records | the `onIncapacitated` hook records `{victim, killer, positions, tp}`; ops read it at scoring time |
| Equipment set-up | `validateEquipmentPlacement(...)` / `placeEquipment(ctx, state, intent)` |

**Why scoring is an entry point rather than an `onEndOfTP` hook**: hook handlers receive
`(event, binding)` and no `GameContext`, so they cannot measure control range, read datacards or
roll dice. Anything needing `ctx` lives in the entry points above (which the reducer/UI calls);
hooks are used only for things that need nothing but `state` (kill records, gambit options, AP
costs, the secret primary-op prompt).

**VP bookkeeping**: `awardVP` enforces "Each player can score a maximum of 6VP from each op",
writes the per-turning-point breakdown into `TeamState.vpByOp[opId][slot]` (slots 0–3 = turning
points 1–4, slot 4 = end-of-battle) and emits `onScore`. Per-turning-point caps (2VP, 3VP for
Dominate) are applied by the ops through `roomThisTP`.

## Crit ops (`state.critOpId`, shared by both players)

| # | Op | Status | Test |
| --- | --- | --- | --- |
| 1 | Secure | ✔ Secure 1AP mission action; secured-until-the-enemy-secures flag; 1VP any + 1VP more | `1. Secure: "If any objective markers are secured…"` |
| 2 | Loot | ✔ Loot 1AP; once per marker per TP; 1VP each, 2VP/TP cap, scored immediately | `2. Loot: "you score 1VP (to a maximum of 2VP per turning point)"` |
| 3 | Transmission | ✔ Initiate Transmission 1AP; transmitting until the start of the next TP; 1VP any + 1VP more | `3. Transmission: markers are "transmitting until…"` |
| 4 | Orb | ✔ Orb token starts on the centre marker; Move Orb 1AP with the centre→either-player choice; 1VP per controlled marker without it | `4. Orb: "At the start of the battle…"` |
| 5 | Stake Claim | ✔ per-TP secret claim (marker + control/uncontested) as a `PendingDecision`, each marker once per battle; 1VP more markers + 1VP true claim | `5. Stake Claim: the claim is a secret PendingDecision…` |
| 6 | Energy Cells | ✔ objective markers become pick-up-able from TP2; +2AP/+1AP/+0AP surcharge that can neither be free nor reduced; 6" cap on being set up again while carrying; 1VP more markers + 1VP per carried marker at the end | `6. Energy Cells: Pick Up Marker on an objective costs…` |
| 7 | Download | ✔ Download 1AP from TP3 on centre/opponent markers, once each per battle; 1VP (TP3) / 2VP (TP4); downloaded markers ignored for control | `7. Download: not before the third turning point…` |
| 8 | Data | ✔ Compile Data 1AP (once per marker per TP) and Send Data 1AP (TP4 only); 1VP for more compiles at the end of TP2/TP3; VP = Data points sent | `8. Data: Compile Data adds a point per turning point…` |
| 9 | Reboot | ✔ markers numbered 1–3 at setup; secret simultaneous number picks each TP as `PendingDecision`s; inert markers ignored for scoring; Reboot 2AP clears inert | `9. Reboot: both players secretly select a number…` |

## Tac ops (secret, one per player, from the team's archetypes)

| Archetype | Op | Status | Test |
| --- | --- | --- | --- |
| Infiltration | Plant Devices | ✔ Plant Device 1AP, Device token per marker per player, 1VP opponent's marker + 1VP per contested marker, 2VP/TP | `Plant Devices: 1VP for a device on "your opponent's objective marker"…` |
| Infiltration | Steal Intelligence | ✔ Intelligence marker placed where each enemy falls; Pick Up Intelligence action for the second carry; 1VP/TP carrying + 1VP each at the end | `Steal Intelligence: "place one of your Intelligence mission markers…"` |
| Infiltration | Track Enemy | ✔ tracked = valid target for a Conceal friendly within 6" that it cannot target back and is not engaged; 1VP/2VP, 2VP/TP | `Track Enemy: the watcher "must have a Conceal order"…` |
| Recon | Flank | ✔ flanks split by `map.flankLine`; contest = wholly within the flank **and** wholly within enemy territory; APL control; reveal as a STRATEGIC GAMBIT; TP4 doubles a flank held since TP3 | `Flank: revealed "As a STRATEGIC GAMBIT"…` |
| Recon | Retrieval | ✔ Retrieve 1AP creates a carried Retrieval marker and searches the objective; 1VP per first search; 1VP each carried at the end | `Retrieval: "The first time each objective marker is searched…"` |
| Recon | Scout Enemy Movement | ✔ Scout 1AP (Conceal only, ready enemy, visible and >6"), monitored for the TP; 1VP per monitored enemy visible to any friendly, 2VP/TP | `Scout Enemy Movement: Scout needs a ready enemy…` |
| Security | Plant Banner | ✔ Plant Banner 1AP with all three placement conditions, once per battle; 1VP controlled / 2VP uncontested; a carried banner scores nothing | `Plant Banner: the banner must be "wholly within your opponent's territory"…` |
| Security | Martyrs | ✔ Martyr token per first incapacitation while contesting; removal resolved greedily (controlled markers first) for 1VP/2VP, 2VP/TP | `Martyrs: a friendly incapacitated while contesting a marker…` |
| Security | Envoy | ✔ envoy chosen as a gambit each TP after the first (never the same operative twice, never one ignored for the kill op); 1VP in enemy territory unengaged, 2VP if unwounded that TP | `Envoy: 2VP when the envoy is in enemy territory…` |
| Seek & Destroy | Rout | ✔ kill within 6" of the opponent's drop zone: 1VP, 2VP vs Wounds 12+; 2VP/TP | `Rout: 1VP for a kill made "within 6" of your opponent's drop zone"…` |
| Seek & Destroy | Sweep & Clear | ✔ Clear 1AP; Swept tokens from kills on contested markers; both VP clauses; 2VP/TP | `Sweep & Clear: a cleared, uncontested marker with a Swept token scores 2VP` |
| Seek & Destroy | Dominate | ✔ 1/2 tokens per kill; cashed at the end of TP3 and TP4, 1VP each, 3VP/TP | `Dominate: tokens are gained per kill and cashed in…` |

## Kill op, primary op, initiative cards

| Rule | Status | Test |
| --- | --- | --- |
| Kill grade table (start 5–14) | ✔ printed table in `data/ops/kill-op.json`; 1VP per new grade; +1VP for the higher grade at the end of the battle | `reproduces the printed kill-grade table exactly…` |
| Operatives "ignored for the kill op" | ✔ excluded from both the starting size and the kill count (`ignoredForKillOp`: an `ignoredForKillOp` effect or the datacard keyword) | same |
| Primary op | ✔ secret `PendingDecision` at the TP1 Ready step (the last point before the Gambit step); end-of-battle bonus = ⌈half the VP scored from that op⌉, recorded under the `primary` id so the source op's 6VP cap does not swallow it | `game A — Secure + kill op + a crit primary op` |
| Initiative cards | ✔ roll-off with no re-rolled ties, team-rule modifiers before cards, alternating card/pass from the roll-off loser until both pass, Re-roll superseding modifiers, winner decides initiative, tie to the player without initiative, loser gains the TP-numbered card (not in TP4), Re-roll card granted at setup | four tests in `describe('initiative cards')` |

## Universal equipment

| Option | Status | Test |
| --- | --- | --- |
| Ammo Cache | ✔ marker + Ammo Resupply 0AP + the re-roll grant on `onRollAttack` (datacard weapons only) | `"AMMO RESUPPLY 0AP…"` |
| Razor Wire | ✔ Exposed + Obstructing terrain feature (72×10×36mm); the +1" crossing cost comes from `movement.ts` | `"Razor wire is Exposed and Obstructing terrain"…` |
| Comms Device | ✔ marker + `supportDistance(ctx, state, op, inches)` (+3" while controlled, never the opponent's) | `"While a friendly operative controls this marker…"` |
| Mines | ✔ marker with all three separation rules; D3+3 damage via the existing trigger in `actions.ts` | `"more than 2" from other markers"…` |
| Light Barricades ×2 | ✔ two Light features (50×10×25mm) with Insignificant + Exposed feet | `light barricades are Light terrain…` |
| Heavy Barricade | ✔ Heavy feature (40×15×45mm), wholly within 4" of the drop zone | `"A heavy barricade is Heavy terrain…"` |
| Ladders ×2 | ◐ two `equipment.ladder` features (20×5×95mm) with every placement rule enforced; the "treat the vertical distance as 1"" discount is `movement.ts`'s existing `ladderAvailable`, which is currently unreachable — see the note below | `"Upright against terrain that's at least 2" tall"…` |
| Portable Barricade | ◐ Light + Protective + Portable feature with feet; Move With Barricade 1AP (Move−2", no climb/drop/jump, the barricade is removed, follows the operative and is not set up again if the 2" rule fails); Protective +1 Save while connected and the shield intervenes. **Portable's "only provides cover while connected" is not enforced** | `"MOVE WITH BARRICADE 1AP…"`, `"Protective: While an operative is in cover…"` |
| Utility Grenades | ✔ Smoke Grenade 1AP (marker, 6" range, D3 duration armed at the next Ready step, removed at the end of that TP, Piercing 2 → 1 against a target in smoke) and Stun Grenade 1AP (D6 per operative, 3+ → −1 APL until the end of its next activation); kill-team-wide use counts | `"SMOKE GRENADE 1AP…"`, `"STUN GRENADE 1AP…"` |
| Explosive Grenades | ✔ Frag (ATK4 HIT4+ 2/4, Range 6" Blast 2" Saturate) and Krak (4/5, Range 6" Piercing 1 Saturate) granted as real weapons, with the kill-team-wide use limit enforced on weapon selection | two tests in `describe('Explosive Grenades')` |
| Breaching Charge | ✔ Breach for 1 less AP (min 1AP), spent once per battle at the end of the activation that used it | `"Once per battle…"` |

Physical footprints are the owner's measurements (mm → inches at 25.4) and are recorded in
`data/equipment/universal.json`. Terrain items are built as real `TerrainFeature`s with correct
`z0`/`z1`, so the same cylinder-vs-prism visibility applies to them — no special cases.

## Decisions (docs/DECISIONS.md style)

| id | Decision | Rationale |
| --- | --- | --- |
| O-001 | **Kill grades outside the printed 5–14 rows.** Above 14: `round(start × grade / 5)`. Below 5: `min(grade, start)`. | The formula reproduces all ten printed rows exactly (pinned by a test), so it is the table's own rule rather than a guess. Below 5 the formula produces duplicate thresholds; one kill per grade keeps grades strictly increasing and lets a tabled kill team reach grade 5. |
| O-002 | **Scoring runs at the end of the turning point, not the instant a kill happens.** | Rout/Dominate/Martyrs/Sweep & Clear/the kill op all key off incapacitations, which are recorded (with the killer and both positions) as they happen. Evaluating them at the end of the turning point cannot change any total — the only limits are per-turning-point caps — and it keeps `GameContext` out of hook handlers. Loot, Download, Send Data and Retrieval score immediately, because their VP depends on when the action was performed. |
| O-003 | **Secret simultaneous choices go through `PendingDecision`** (primary op, Stake Claim, Reboot numbers) and are raised from the `onReadyStep` hook, which is the last moment before the Gambit step. The reducer blocks every other intent until they are answered, so the timing matches "at the start of the Gambit step". | Pass-and-play must be able to hide them, and the reducer already treats a pending decision as a hard block. |
| O-004 | **Stake Claim and Reboot picks are simultaneous rather than sequential.** The card says Stake Claim starts "with the player with initiative". | Both are raised at once and neither player can see the other's answer, which is stricter than the sequential reading and never leaks information. |
| O-005 | **"You can remove any of those tokens" (Martyrs, Dominate) is auto-resolved** to the VP-maximising choice (controlled markers first for Martyrs). | The optimum is unambiguous and the alternative is a decision prompt with no real choice in it. |
| O-006 | **Energy Cells' Pick Up Marker surcharge is applied when the nearest pick-up-able marker is an objective marker.** | `onActionCost` does not know which marker the action targets. This is exact unless a tac-op marker (Retrieval/Banner/Intelligence) is closer to the operative than an objective marker in the same battle. |
| O-007 | **A second carried Intelligence marker uses a separate `Pick Up Intelligence` action** (treated as Pick Up Marker for action restrictions), and extra carried markers are re-positioned at the end of each activation. | `OperativeState` has one `carryingMarkerId`, and the core Pick Up Marker action rejects a second carry. |
| O-008 | **The Smoke Grenade's D3 is rolled when the grenade is thrown**, not in the next Ready step, and applied there. | `onReadyStep` handlers have no RNG. The distribution and the number of RNG draws are unchanged; only the log line moves. |
| O-009 | **The Orb token, Device/Martyr/Swept/Data/Device tokens and "secured/looted/downloaded/inert" states are flags on the objective marker**, not separate marker entities. Intelligence, Retrieval, Banner, Smoke, Ammo Cache, Comms Device and Mines are real markers because they are picked up, placed or measured to. | `MarkerState.flags` is the documented home for "op-specific flags: used this TP, downloaded, inert, claimed by, etc." |
| O-010 | **Two equipment depths are assumptions**: heavy barricade 15mm, portable barricade 10mm. Both are flagged in `data/equipment/universal.json`. | The owner supplied width and height only. Depth only affects the footprint's thickness. |
| O-011 | **"Connected to" a portable barricade = the base is within 0.25" of the shield.** | The rules describe it physically ("connected to the inside of it"); a touching test is the closest measurable equivalent. |

## Not automated (and why)

- **Portable barricade: "only provides cover while an operative is connected to it"** — cover is
  computed in `visibility.ts`, which has no hook for excluding a part, so a *disconnected*
  operative can still gain ordinary Light cover from the shield. The Protective +1 Save *is*
  gated on being connected. Fixing it properly needs a cover-ignore hook in `visibility.ts`.
- **Ladders' climb discount** — the feature is built with `kind: 'equipment.ladder'`, which is
  exactly what `movement.ts`'s `ladderAvailable` looks for, but `movement.ts`'s `closestSurface`
  always picks the surface nearest the operative's current elevation and `surfacesAt` always
  includes the floor, so a climb *up* from the killzone floor can never be planned today. The
  ladder rule will start working as soon as that is fixed; it is not an ops/equipment problem.
- **Energy Cells' "cannot be removed and set up again more than 6" away"** is enforced through
  the `onSetUpAgain` hook. Team rules that remove and set up an operative must emit that hook
  (FLY, Shadow Passage, teleport pads); nothing in the core does yet.
- **Flank's printed diagram** ("just like the centreline, except it runs from the centre of each
  player's killzone edge") is taken from `map.flankLine`, so it is only as good as the map data.
- **"Ignored for the kill op"** has no team rules to bind to yet; the seam is an
  `ignoredForKillOp` effect or a datacard keyword.

## Wiring left for the reducer/UI owner

Everything below is a one-line call; none of it changes existing behaviour.

1. `phases.endTurningPoint` (or the reducer's `advanceTurningPoint`) → `scoreEndOfTurningPoint(ctx, state)`;
   the battle-end branch → `scoreEndOfBattle(ctx, state)`.
2. `decisions.resolveDecision`'s `default:` branch → `resolveOpDecision(ctx, state, id, optionId, data)`
   so `ResolveDecision` intents reach op decisions (they are answered directly today).
3. Reducer `case 'PlaceEquipment'` → `placeEquipment(ctx, next, intent)` (returns `{ok, reason}`).
4. Reducer `case 'RollOff'` in a battle turning point → `beginInitiative(ctx, next)`, and
   `PlayInitiativeCard` / `PassInitiativeCards` → the decisions raised by it; after
   `ChooseDropZone` → `grantSetupRerollCard(state, opponent)`.
5. After the crit op and both tac ops are chosen → `initOps(ctx, state)`.
6. `makeContext({ ops: opsMap(), equipment: equipmentMap() })`.
