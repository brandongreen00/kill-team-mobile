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
| **celestian-insidiants** | pinned | ✅ shared validator | 4/4 | 4/4 | 4/4 | 4/4 | 3/3 | 12/12 | AntiPSYKER ✅ Shield ✅ | 35 | ✅ 2 maps | INSPIRING and the four BENEDICTIONs are effects on the operative; Martyrdom raises a real BENEDICTION decision (operative × benediction) through `decisionHandlers`, and VOCIFERA MORTIS widens its candidate list once per battle. HOLY DEFENDER and the Zealous Ultimatum use the two new seams (`onSelectTarget`, a decision the OPPONENT answers). Bladed Stance is partial — it reorders the fight so the retaliating MORTISANCTUS resolves first, but the engine generates the strike/block options so "that success must be used to block" cannot be enforced. Two clauses are reminder-only: PSYCHIC actions' "friendly CI operatives cannot be selected" (a team cannot reach into another team's unique-action target selection) and HOLY DEFENDER's Fight half (only the Shoot step has a target-substitution seam). |
| **kommandos** | pinned | ✅ shared validator | 1/1 | 4/4 | 4/4 | 4/4 | 5/5 | 9/10 | ConcealedPosition ✅ Explosive ✅ | 28 | ✅ 2 maps | Throat Slittas is its own `Charge (Throat Slittas)` action (`treatedAs: 'Charge'`) because the universal Charge refuses a Conceal order and `canPerformAction` can only forbid; Krumpin' Time and Explosive are registered the same way (the Explosive shot targets the BOMB SQUIG itself through the point-blank path, with its Hit penalty cancelled). Taktical Wot-notz delegates to the universal grenade actions and restores the kill team's grenade uses afterwards ("doesn't count towards their action limits"). Boom! rolls its 2D6 and resolves the explosion as direct Blast damage — the engine has no "free action on death" seam (`onIncapacitated.freeActions` is declared but never consumed). BREACH places its marker and takes the AP discount; its "treats … as Accessible terrain" grant is reminder-only (terrain types are compiled from the map, with no runtime seam). Expendable is reminder-only: it is op scoring, owned by `src/core/ops/**`. |
| **pathfinders** | pinned | ✅ shared validator | 1/1 | 4/4 | 4/4 | 4/4 | 15/15 | 18/19 | — (none printed) | 37 | ✅ 2 maps | Markerlight tokens are one pure count (`markerlightTokens`) that every band reads: 1 → Saturate + Balanced, 2 → +1 Hit via `onStatMod` (capped at 3+), 3 → clears `seq.obscured`, 4 → Seek Light; they are shed at the end of an enemy activation in which it moved. SAVIOUR PROTOCOLS redirects through `onSelectTarget` and SUPPORTING FIRE through the new `ignoreFriendlyControlRange` flag. Group Activation is partial — the pairing is recorded as an effect for the UI/AI, because the engine alternates activations strictly (same as the Breachers' Breach and Clear). POINT-BLANK FUSILLADE swaps in a melee copy of a ranged weapon and hands the defender the first dice; its "you cannot block" clause is unenforceable (the engine generates the strike/block options). |
| **hierotek-circle** | pinned | ✅ shared validator | 3/3 | 4/4 | 4/4 | 4/4 | 16/16 | 6/6 | Magnify ✅ | 33 | ✅ 2 maps | Reanimation Protocols leaves a marker (clearing the operative's tokens and effects), and the Ready step raises a real decision — marker × order — that rolls, revives on a 3+ with 1 wound and re-offers a different marker on a 1-2. A REANIMATED operative keeps its id, so the **Martyrs tac op cannot score twice for it** (pinned by a test), and Living Metal still heals it because it resolves "after all other rules in this step". Magnify uses the new `onValidTarget.viewFrom` proxy seam (visibility, cover and obscured from the APPRENTEK/CRYPTEK; range stays the shooter's) plus Ceaseless. Not implemented: REANIMATE's "if you spent 1 additional AP" automatic mode (the printed 2AP roll is), and REANIMATED FUNCTION's "no effect for the Martyrs tac op" carve-out — `onMarkerControl` carries no caller, so ordinary control and op scoring cannot be told apart. VISION OF MADNESS is modelled as −1 APL on the activation it interrupts: the engine has no way to refuse an activation. |

All eight batch-1 teams are implemented. `tests/teams/selection.test.ts` covers every team's
printed selection requirements, and `tests/teams/soak.test.ts` plays the whole batch in a ring
(8 pairings × 2 maps) with zero rejected intents.

## Engine seams added for team rules

All additive, all reported:

| seam | why |
| --- | --- |
| `onWeaponRules` hook + emit in `effectiveRules` (`src/core/sequences/shoot.ts`) | "friendly X operatives' weapons have the Severe/Ceaseless/Accurate 1 … weapon rule" is the single most common team-rule shape. Emitted on every read, so a grant can never go stale mid-sequence. |
| `onPloyUsed` hook + emit in `UseGambit`/`UsePloy` (`src/core/reducer.ts`) | A ploy's *immediate* effect (place a marker, grant an effect, hand out a free action) had no seam at all — ploys could only be read back from `ploysUsedTP`. |
| `onBlockAllocation` payload gains `blocks` and `normalsCanBlockCrits`, emitted in `resolveFightDie` | The rare `Shield` weapon rule ("each block can block two successes") and the AoD `DUELLER` tactic ("normal successes can block critical successes") both change block allocation. |
| `TeamModule.register(reg, player, ctx?)` | Hook handlers get no `GameContext`, but team rules need datacards (keywords, bases) and base-to-base geometry. |
| `onSetUpAgain` added to `HOOK_NAMES` | Referenced by `src/core/ops/crit/energyCells.ts` (another agent's file) but not yet declared — added so the tree typechecks. |
| `onSelectTarget` hook + emit in `startShoot` (`src/core/sequences/shoot.ts`) | "…becomes the valid target instead (even if it wouldn't normally be valid for this)" — Celestian Insidiants' HOLY DEFENDER and Pathfinders' SAVIOUR PROTOCOLS. The substitute inherits the original target's cover/obscured, exactly as both rules print it. Also carries the Kommandos' Explosive shot, whose primary target is the BOMB SQUIG itself. |
| `onValidTarget` payload gains `viewFrom` and honours the (previously dead) `forceVisible`; the emit moved above the visibility and friendly-control-range checks | The Hierotek Circle's Magnify rule determines "a valid target, cover and obscured" from ANOTHER operative. `forceVisible` was declared but the early return fired before the hook was emitted, so it could never take effect. |
| `onValidTarget` payload gains `ignoreFriendlyControlRange` | "Having other friendly PATHFINDER operatives within an enemy operative's control range doesn't prevent that enemy operative from being selected" (SUPPORTING FIRE). |
| `onSelectWeapon` is now emitted (in `startShoot`) | The hook was declared but never emitted, so the rare `Concealed Position` rule — a PROFILE-level restriction that `availableWeapons` (per weapon) cannot express — was a silent no-op. |
| `onStunTest` hook + emit in the universal Stun Grenade action (`src/core/equipment/grenades.ts`) | Celestian Insidiants' PSYK-OUT GRENADES adds damage to a stun test on a 3+ (the whole dice result against a PSYKER). The stun test is rolled inside the universal action and had no seam at all. |

## Known engine gaps (not team bugs)

- **Team-raised choices go through `GameContext.decisionHandlers`** (a team pushes its handler in
  `register`): Celestian Insidiants' BENEDICTION / Zealous Ultimatum / AUTO-FLAGELLATOR and the
  Hierotek Circle's Reanimation Protocols all raise their own `PendingDecision` kinds. What is
  still missing is a decision channel during **Select Operatives** (Angels of Death's CHAPTER
  TACTICS still need the pure setter) and any way to ask a question that is not a finite option
  list — a position on the killzone floor is still taken from `UsePloy`/`UseGambit` `data` with a
  deterministic, logged default (D-016).
- **`RosterPick.loadoutId` / `weapons` are dropped by `SelectRoster`.** The shared validator computes
  each operative's weapons; `applyLoadouts` records them under `state.opState['loadout']` for the UI.
- **No "perform an action outside your activation" intent.** Free-action grants are modelled as one
  extra AP restricted to the named action (`grantFreeAction`, docs/DECISIONS.md D-015).
- **CP is deducted before `onPloyUsed` fires**, so "this ploy costs you 0CP" abilities are refunds.
- **`StatMods.hit` from `onCollectAttackDice` is never read.** `shoot.ts` computes `hit` from
  `hitOf()` and only uses `mods.atk`; `fight.ts` does the same. A `+1 to hit` written there is a
  silent no-op — it must go through `onStatMod` (which `hitOf` does consult), reading
  `state.sequence` for the weapon/target context. **This makes the Imperial Navy Breachers'
  GRENADIER ability (`src/teams/imperial-navy-breacher/index.ts:190-195`) inert**: "improve the
  Hit stat of that weapon by 1" never happens.
- **`aplOf` ignores hooks entirely** (`src/core/state.ts:78-83`): it reads `op.aplMods` and
  nothing else, so `StatMods.apl` is dead and "ignore any changes to its APL stat" rules have to
  clear `op.aplMods` at the moments they can reach (Kommandos SHAKE IT OFF, Breachers REBREATHERS).
- **Declared but never emitted**: `onBattleSetup`, `onAttackDiceRetained`, `onFreeActions`,
  `onOrderChange`, `onMoveRules`, `onSetUpAgain`, and `onIncapacitated.freeActions`. Each is a
  silent no-op for any rule that registers against it (architecture rule 5 says a hook never is).
  `onOrderChange` in particular means "this operative cannot have an Engage order" (Kommandos
  GROT, BOMB SQUIG) has to be corrected at `onActivationStart` instead of refused at the choice.
- **A unique action's target legality must live in `check`, not `perform`.** `src/ai/legal.ts`
  `missionCandidates` offers friendly AND enemy targets and only re-runs `def.check`, so anything
  `perform` refuses becomes a rejected intent. Found twice while soaking batch 1's second half —
  once in this batch's own SPEAK OF HER DEEDS, and once in Plague Marines' POISONOUS MIASMA
  (`check` accepted any `targetOperativeId`, `perform` then refused a friendly one); both now
  validate in `check`. Worth a lint: no `perform` should return a reason its `check` cannot.
