# Team status

`done` requires: data pinned by tests · selection rules enforced · faction rules, 4 strategy ploys,
4 firefight ploys, 4 equipment, unique actions and abilities implemented as hooks with tests ·
rare weapon rules implemented · a bot-vs-bot soak game on two maps with zero rejected intents.

Every module lives in `src/teams/<slug>/index.ts`, is registered in `src/teams/index.ts`, and reads
its printed rule text from `data/teams/<slug>.json` (never retyped). Selection rules are one shared,
data-driven validator: `src/teams/selection.ts`.

| team | data | selection | faction rules | strategy ploys | firefight ploys | equipment | unique actions | abilities | rare rules | tests | AI game | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **kasrkin** | pinned | ✅ shared validator | 2/2 | 4/4 | 4/4 | 4/4 | 4/4 | 7/9 | ConcealedPosition ✅ | 26 | ✅ 2 maps | Skill at Arms is 4 gambit options (never picked silently) + Veteran Leadership's second pick. Rapid Fire is a second `Shoot (Rapid Fire)` action. Melta Mine / Proximity Mine are reminder-only — they need a carried-marker mine the Pick Up/Place Marker actions can own (engine gap, see notes below). |
| **angel-of-death** | pinned | ✅ shared validator | 2/2 | 4/4 | 4/4 | 4/4 | 1/1 | 5/8 | — | 17 | ✅ 2 maps | All six CHAPTER TACTICS bound; chosen through `setChapterTactics` (Select Operatives has no decision channel — nothing applies until chosen). Astartes is two extra actions (`Shoot (Astartes)` / `Fight (Astartes)`). Heroic Leader and Doctrine Warfare (CP discounts on a ploy you *would* use) are reminder-only: the reducer charges CP before any hook sees the ploy, so a discount can only be modelled as a refund, and both are conditional on a choice made before the ploy is paid for. |
| **plague-marines** | pinned | ✅ shared validator | 3/3 | 4/4 | 4/4 | 4/4 | 3/3 | 7/8 | Poison ✅ Toxic ✅ PSYCHIC ✅ | 18 | ✅ 2 maps | Poison tokens are per-player effects on the bearer; Disgustingly Resilient rolls through the injected RNG. Icon of Contagion (Contagion free inside enemy territory) is reminder-only — same CP-before-hook ordering as above. |
| **imperial-navy-breacher** | pinned | ✅ shared validator | 2/2 | 4/4 | 4/4 | 4/4 | 7/7 | 10/12 | Shield ✅ Detonate ⚠ partial | 20 | ✅ 2 maps | Breach and Clear records the paired operative as an effect; the UI/AI reads it to offer the back-to-back activation. Detonate enforces "cannot be selected if your GHEISTSKULL isn't in the killzone" but its "shoot everything within 2\" of the marker instead of a valid target" needs a target-selection seam. Expendable (op scoring exclusions) is reminder-only: it belongs to `src/core/ops/**`, owned by another agent. |
| _celestian-insidiants_ | pinned | ✅ shared validator | — | — | — | — | — | — | AntiPSYKER, Shield | — | — | **not implemented** (batch-1 remainder) |
| _kommandos_ | pinned | ✅ shared validator | — | — | — | — | — | — | ConcealedPosition, Explosive | — | — | **not implemented** (batch-1 remainder) |
| _pathfinders_ | pinned | ✅ shared validator | — | — | — | — | — | — | — | — | — | **not implemented** (batch-1 remainder) |
| _hierotek-circle_ | pinned | ✅ shared validator | — | — | — | — | — | — | Magnify | — | — | **not implemented** (batch-1 remainder) |

The four unimplemented teams already have their data pinned and their selection requirements
enforced by the shared validator (`tests/teams/selection.test.ts` covers all eight), so adding a
module is only the hook wiring.

## Engine seams added for team rules

All additive, all reported:

| seam | why |
| --- | --- |
| `onWeaponRules` hook + emit in `effectiveRules` (`src/core/sequences/shoot.ts`) | "friendly X operatives' weapons have the Severe/Ceaseless/Accurate 1 … weapon rule" is the single most common team-rule shape. Emitted on every read, so a grant can never go stale mid-sequence. |
| `onPloyUsed` hook + emit in `UseGambit`/`UsePloy` (`src/core/reducer.ts`) | A ploy's *immediate* effect (place a marker, grant an effect, hand out a free action) had no seam at all — ploys could only be read back from `ploysUsedTP`. |
| `onBlockAllocation` payload gains `blocks` and `normalsCanBlockCrits`, emitted in `resolveFightDie` | The rare `Shield` weapon rule ("each block can block two successes") and the AoD `DUELLER` tactic ("normal successes can block critical successes") both change block allocation. |
| `TeamModule.register(reg, player, ctx?)` | Hook handlers get no `GameContext`, but team rules need datacards (keywords, bases) and base-to-base geometry. |
| `onSetUpAgain` added to `HOOK_NAMES` | Referenced by `src/core/ops/crit/energyCells.ts` (another agent's file) but not yet declared — added so the tree typechecks. |

## Known engine gaps (not team bugs)

- **No decision channel for team-raised choices.** `resolveDecision` has no hook for a team's own
  `PendingDecision` kinds, so any rule whose choice is not expressible as a gambit option, a reroll
  grant or an intent `data` payload has to be given a deterministic, logged default. Where the
  choice matters, these modules instead expose a pure setter (`setChapterTactics`) or take the pick
  from `UsePloy`/`UseGambit` `data`.
- **`RosterPick.loadoutId` / `weapons` are dropped by `SelectRoster`.** The shared validator computes
  each operative's weapons; `applyLoadouts` records them under `state.opState['loadout']` for the UI.
- **No "perform an action outside your activation" intent.** Free-action grants are modelled as one
  extra AP restricted to the named action (`grantFreeAction`, docs/DECISIONS.md D-015).
- **CP is deducted before `onPloyUsed` fires**, so "this ploy costs you 0CP" abilities are refunds.
