# Rules coverage

Each row: rule → implementation → test. ✔ implemented · ◐ partial · ✘ not started.
Test names are the `it(...)` strings; every one of them quotes the rule text it pins.

## Battle / turning-point structure

| Rule | Status | Implementation | Test |
| --- | --- | --- | --- |
| Turning point = Strategy phase then Firefight phase, repeat | ✔ | `phases.ts`, `reducer.ts::advanceTurningPoint` | `turning-point structure` |
| Strategy 1 — Initiative: roll-off, winner decides; tie → the player who didn't have initiative decides | ✔ | `phases.ts::rollInitiative`, `reducer.ts` `RollOff` | `rules.test.ts` (tie path via reducer) |
| Strategy 2 — Ready: 1CP each, 2CP for the non-initiative player from TP2, ready all | ✔ | `phases.ts::readyStep` | `Ready: 1CP each, 2CP for the player without initiative from TP2` |
| Strategy 3 — Gambit: alternate STRATEGIC GAMBIT / pass until both pass; each gambit once per TP | ✔ | `phases.ts::gambitOptions`, `reducer.ts` `UseGambit`/`PassGambit` | ops suite |
| Firefight 1 — Determine Order (Engage/Conceal, kept until next activated) | ✔ | `reducer.ts` `ActivateOperative` | core suite |
| Firefight 2 — Perform Actions: AP ≤ APL, action restrictions, min 0AP, decide after seeing effects | ✔ | `actions.ts::actionCost`/`availableActions`, `reducer.ts` `PerformAction` | `rejects a second Reposition in the same activation` |
| Cancel-and-revert when an action cannot be completed | ✔ | `reducer.ts` `PerformAction` (state snapshot before `perform`) | core suite (rejected shot leaves state unchanged) |
| Firefight 3 — Expended | ✔ | `reducer.ts` `EndActivation` | core suite |
| Counteract: expended Engage operative, free 1AP excluding Guard, ≤2", once per TP, not an activation | ✔ | `phases.ts::counteractCandidates`, `reducer.ts` `Counteract` | `counteract: an expended Engage operative, once per turning point, and not an activation` |
| Battle ends after 4 turning points; most VP wins, ties draw | ✔ | `phases.ts::MAX_TURNING_POINTS`, `determineWinner` | ops suite |

## Universal actions

| Action | Status | Implementation | Test |
| --- | --- | --- | --- |
| Reposition 1AP | ✔ | `actions.ts` | `rounds each straight-line increment up to the nearest inch` |
| Dash 1AP (3", no climb, may drop/jump) | ✔ | `actions.ts`, `movement.ts` `noClimb` | `Dash cannot climb but may drop` |
| Fall Back 2AP | ✔ | `actions.ts` | rules suite |
| Charge 1AP (+2", must finish engaged, sticky when sole engager) | ✔ | `actions.ts` | `a Charge must finish within control range of an enemy operative` |
| Pick Up Marker 1AP / Place Marker 1AP (0AP forced when incapacitated) | ✔ | `actions.ts`, `state.ts::removeIncapacitated` | ops suite |
| Shoot 1AP — the 6-step sequence | ✔ | `sequences/shoot.ts` | `resolves a full shoot sequence deterministically and inflicts damage` |
| Fight 1AP — the 4-step sequence incl. assists | ✔ | `sequences/fight.ts::assistCount` | teams suite |
| Guard 1AP + On Guard (Close Quarters only) | ✔ | `actions.ts`, `reducer.ts` `OnGuardInterrupt` | `Guard is not offered on an open killzone` / `Guard is available in a Close Quarters killzone` |
| Hatchway Fight 1AP (Close Quarters) | ✔ | `actions.ts` | teams/ops suite |
| Door Fight 1AP (Volkus Cityfight) | ✔ | `actions.ts` | `rules-review.test.ts` |
| Operate Hatch 1AP (maps with hatchways) | ✔ | `actions.ts` | maps suite |
| Breach 2AP + AP discounts + concussion roll (Tomb World) | ✔ | `actions.ts` | maps suite |
| Move With Barricade 1AP (Portable Barricade) | ◐ | `src/core/equipment/` | equipment suite |

## Key principles

| Rule | Status | Implementation | Test |
| --- | --- | --- | --- |
| Bases: may touch, never stack; friendly pass-through; not through terrain; not off-board | ✔ | `geometry.ts::basesOverlap`, `movement.ts` | `a base cannot be over the edge of the killzone` |
| "Operatives cannot move through terrain — they must move around, climb over or drop/jump off it" | ✔ | `terrain.ts::pathBlockedByTerrain`, checked per increment in `movement.ts::validateMove` and `reachableCells`; `movement.ts::routePath` builds the way round (D-064, D-065) | `cannot move through terrain`, `a route around the terrain is legal even though the straight line through it is not`, `an operative cannot walk through a wall` |
| Accessible: move through, +1", centre of base only — "takes precedence over Bases, and Terrain and Movement" | ✔ | `terrain.ts::accessibleCrossings` + the `Accessible` exemption in `pathBlockedByTerrain` | `Accessible terrain can still be moved through` |
| Insignificant: "can move over and across ... without going up and down" | ✔ | `pathBlockedByTerrain` exemption | `Insignificant terrain does not block a move` |
| Control range = visible to and within 1", mutual | ✔ | `visibility.ts::withinControlRange` | core suite |
| Bases: "not through enemy operatives"; "cannot move within control range of an enemy operative, unless…" | ✔ | `movement.ts::enemyOnTheWay`, per increment; relaxed through `onMovePermissions` (D-072) | `friendly operatives can move through other friendly operatives … but not through enemy operatives`, `it cannot move within control range of an enemy operative` |
| Seek / Vantage deny cover for TARGETING only — "it doesn't remove their cover save (if any)" | ✔ | `visibility.ts::coverAndObscured` returns `inCover` (the save) and `inCoverForTargeting` (D-068) | `Seek: "it doesn't remove their cover save (if any)"` |
| Lethal x+ survives a re-roll | ✔ | `dice.ts::lethalOpts` carried in the reroll decision's `ctx` | `a RE-ROLLED result is graded the same way` |
| Devastating x / Stun fire on RETAINED critical successes | ✔ | `Die.blockedFrom` distinguishes a blocked crit from a blocked normal | `a blocked NORMAL success is not a critical success` |
| Command Re-roll is exempt from the once-per-TP ploy cap | ✔ | `decisions.ts::applyReroll`, `shoot.ts`, `fight.ts` | `other than Command Re-roll, each player cannot use each ploy more than once per turning point` |
| Fight: "both players select one melee weapon to use that their operative has" | ✔ | `fight.ts::meleeProfileOf` | `not the first profile on the card` |
| Damage / wounded / injured (−2" Move floor 4", Hit −1) / incapacitated | ✔ | `state.ts::inflictDamage`, `isInjured`, `moveOf` | `injured: -2" Move (floor 4") and Hit worsened by 1` |
| Cover: intervening terrain within the target's control range, denied within 2" | ✔ | `visibility.ts::coverAndObscured` | `cover is denied within 2" of the active operative` |
| Obscured: intervening Heavy terrain, ignoring Heavy within 1" of either operative | ✔ | `visibility.ts::coverAndObscured` | `obscured ignores Heavy terrain within 1" of either operative` |
| Cannot be in cover from and obscured by the same feature — defender chooses | ✔ | `coverAndObscured` `mustChoose` → `coverOrObscured` decision | core suite |
| APL clamp ±1 | ✔ | `state.ts::aplOf` | `APL changes clamp to -1/+1 no matter how many apply` |
| Dice: D3 = D6 halved rounding up; re-roll once; rerolls alternate from the initiative player | ✔ | `rng.ts::d3`, `decisions.ts::applyReroll` | core suite |
| Distances: closest points, base only, within vs wholly within | ✔ | `geometry.ts::baseGap`, `baseWhollyWithin` | `measures base-to-base, not centre-to-centre`, `"wholly within" requires every part of the base inside` |
| Equipment: up to 4 options, each once per player | ✔ | `reducer.ts` `SelectEquipment` | equipment suite |
| Intervening / targeting lines (2D vs 3D) | ✔ | `visibility.ts::targetingLines`, `interveningParts` | core suite |
| Markers: objective 40mm, others 20mm; contest within control range; control by total APL | ✔ | `state.ts::markerContestedBy`, `markerController` | ops suite |
| Orders: Conceal at set-up, changed on activation | ✔ | `reducer.ts` `DeployOperative`, `ActivateOperative` | core suite |
| Ploys: strategy = gambit, firefight when specified, once per TP except Command Re-roll | ✔ | `reducer.ts` `UsePloy`, `sequences/shoot.ts::COMMAND_REROLL` | teams suite |
| Valid target (Engage: visible; Conceal: visible and not in cover; no friendlies in its control range; Range x) | ✔ | `sequences/shoot.ts::checkTarget` | `rejects a shot out of visibility rather than throwing` |
| Visible: head → any part of the miniature, bases ignored | ✔ | `visibility.ts::isVisible` | `Heavy terrain in the way blocks visibility` |

## Weapon rules (Appendix › WEAPON RULES — all 23)

| Rule | Status | Note |
| --- | --- | --- |
| Accurate x | ✔ | Auto-retained normal successes are added as unrolled dice; multiple instances collapse to Accurate 2 (`dice.ts::accurateValue`). |
| Balanced | ✔ | Re-roll grant, mode `one`, offered as a decision. |
| Blast x | ✔ | Secondary targets are queued on the sequence; valid regardless of Conceal; cover/obscured inherited from the primary; casualties removed only when the whole action ends. |
| Brutal | ✔ | Passed into `allocateSavesOptimally` and disables normal-success blocks in the fight ticker. |
| Ceaseless | ✔ | Re-roll grant, mode `value` — the player picks which result to re-roll. |
| Devastating x / x" Devastating x | ✔ | Fires on retained crits before blocking; the success is still resolved. Radius form hits every operative visible to and within x. |
| Heavy / Heavy (x only) | ✔ | Checked against the actions performed this activation in `actions.ts` Shoot. Explicitly does not prevent Guard. |
| Hot | ✔ | One D6 after the action, damage = result × 2 when below the Hit stat; one roll even for Blast. |
| Lethal x+ | ✔ | `dice.ts::classify` critical threshold. |
| Limited x | ✔ | `OperativeState.weaponUses`; multiple uses in one action count once. |
| Piercing x / Piercing Crits x | ✔ | `dice.ts::piercingValue`, applied to the defence dice count. |
| Punishing | ✔ | Retention option offered after crits are retained. |
| Range x | ✔ | `checkTarget`. |
| Relentless | ✔ | Re-roll grant, mode `any`. |
| Rending | ✔ | Retention option. |
| Saturate | ✔ | Denies the cover save in `rollDefence`. |
| Seek / Seek Light | ✔ | `checkTarget` sets `ignoreCoverTerrain`; the cover save is NOT removed. |
| Severe | ✔ | Retention option; blocked while obscured (crits cannot be created). |
| Shock | ✔ | First critical strike per sequence discards an unresolved opposing success. |
| Silent | ✔ | Shoot permitted with a Conceal order. |
| Stun | ✔ | −1 APL until the end of the target's next activation. |
| Torrent x | ✔ | Secondary valid targets within x of the first, not within control range of friendlies. |
| Multiple instances / player-chosen order of simultaneous rules | ✔ | `dice.ts::ruleOf` takes the best x; retention options are offered as an ordered decision. |

## Killzone rules

| Rule | volkus | bheta-decima | gallowdark | tomb-world | Implementation |
| --- | --- | --- | --- | --- | --- |
| Heavy / Light / Blocking / Vantage / Accessible / Insignificant / Exposed / Ceiling | ✔ | ✔ | ✔ | ✔ | `terrain.ts`, `visibility.ts` |
| Climb (1" horizontal, 3" vertical, min 2") / Drop (2" ignored per action) / Jump (from >2" Vantage, ≤4") | ✔ | ✔ | ✔ | ✔ | `movement.ts` |
| Vantage Accurate 1/2, Conceal-in-Light denial, improved cover save, ignore connected Heavy | ✔ | ✔ | — | ✔ | `visibility.ts::vantageAccurate`, `vantageIgnoreFilter` |
| Barred (visibility only within 1" horizontally) | ✔ | — | — | — | `visibility.ts::partBlocksLine` |
| Wall (no movement/visibility through; distances measured around; only corners/ends intervene unless passed) | — | — | ✔ | ✔ | `terrain.ts::wallRouteDistance`, `wallCornerZones`, `shooterHasPassed` |
| Hatchway open/closed, Operate Hatch | — | — | ✔ | ✔ | `terrain.ts::effectivePart`, `actions.ts` |
| Breach point + Breach 2AP + concussion | — | — | — | ✔ | `actions.ts` |
| Teleport pad (one operative, not on the floor, mutual control range, teleport from TP2) | — | — | — | ◐ | `types.ts::onTeleportPadId`, `state.ts::inControlRange` — the teleport move itself is pending |
| Hazardous area (no base may touch; restricted targeting/movement) | — | ✔ | — | — | `terrain.ts::baseTouchesHazardous`; the 4"-of-hazardous targeting restriction is pending |
| Cityfight: Door Fight 1AP | ✔ | — | — | — | `actions.ts` — gated on `killzone === 'volkus'` AND a `role: 'door'` part existing (D-104) |
| Stronghold H: one friendly operative on the highest upper level | ◐ | — | — | — | `terrain.ts::occupancyCapExceeded`, called by `validateMove`, `canDeployAt` and the two team set-up-again paths (D-105). The cap is enforced; "placed to one side" and the oversized-base fallback are not |
| Cityfight: Garrisoned Stronghold, Condensed Stronghold | — | — | — | — | **not implemented** — Volkus has no killzone module (audit W-29) |
| Close Quarters: Condensed Environment, Guard/On Guard, Hatchway Fight | — | — | ✔ | ✔ | `weaponRules.ts::condensedEnvironmentRules`, `actions.ts`, `reducer.ts` — gated by `map.closeQuarters` (D-002) |

## Known gaps

- Teleport-pad teleporting (Charge/Fall Back/Reposition swap) is modelled in state but the move
  variant is not yet wired into the actions.
- Bheta-Decima restricted targeting (4" of hazardous between floor-level operatives; gantry
  footprints between Vantage and floor) is specified in `data/terrain/bheta-decima.json` but not
  yet enforced in `checkTarget`.
- Volkus Stronghold B: the one-friendly-operative cap is enforced (D-105). The rest of
  § Stronghold H is not — "that operative must be placed on one side or the other of that level,
  it cannot be placed in the middle", and the oversized-base fallback. The plate measures
  2.04" × 2.15", so a 32mm base does not fit inside either ~1.02" half, which makes the
  oversized-base case the normal one on this geometry rather than the exception. Splitting the
  plate needs a division the cards do not print; see docs/RULES-AUDIT-PLANS.md W-31.
- Volkus has no killzone module, so Garrisoned Stronghold and Condensed Stronghold are
  unimplemented; see docs/RULES-AUDIT-PLANS.md W-29.
