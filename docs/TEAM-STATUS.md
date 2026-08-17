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

### Batch 2 — Astartes and Heretic Astartes

| team | data | selection | faction rules | strategy ploys | firefight ploys | equipment | unique actions | abilities | rare rules | tests | AI game | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **scout-squad** | pinned | ✅ shared validator | 1/1 | 4/4 | 4/4 | 4/4 | 3/3 | 7/7 | — (none printed) | 37 | ✅ 2 maps | Forward Scouting's six selections go through the pure setter `selectForwardScouting` (D-017's shape — Set Up Operatives has no decision channel); Devise Plan, Spy, Redeploy, Reposition, Trip Alarm, Designate Target and the two gambits all resolve. Astartes is the `Shoot (Scout Astartes)` / `Fight (Scout Astartes)` pair, and its "can counteract regardless of its order" is **live** on the SERGEANT datacard (the clause is printed there, not on a faction rule) through the widened `onCounteract` seam. Booby Trap is partial: the 2D3 lands but springs at the activation boundary, because `checkMines` is core-only and `applyMove` emits no marker-trigger hook, so "end its action" cannot be honoured. Designate Target is exact when shooting; its fighting/retaliating half is modelled as Balanced, which adds nothing when Balanced is already present (`fight.ts` emits no `onRollAttack`). Grapnel Launcher is reminder-only (no seam changes a climb's charged vertical distance); Grapnel Assault is partial (climbs and drops are detected as an elevation change across the activation; a level jump and "moves underneath Vantage terrain" are invisible). SNIPER Camo Cloak takes the "additional cover save" branch deterministically; TARGETING OCULARS auto-fires up to twice per TP under D-022. |
| **murderwing** | pinned | ✅ shared validator | 2/3 (+1 partial) | 4/4 | 3/4 (+1 partial) | 4/4 | 4/4 (+3 from equipment) | 9/10 | — (none printed) | 57 | ✅ 2 maps | The BOOST is three sibling `ActionDef`s — `Reposition (BOOST)` / `Fall Back (BOOST)` / `Charge (BOOST)`, each `treatedAs` its universal action (D-021) — because `validateMove` has no per-increment seam and `onMoveRules` is never emitted. Each charges the boosted inches against the same allowance and the Charge variant drops the printed +2"; the swept area is stored as an effect, which is what gives BOOST ZONE a real definition. **Jump Pack is partial**: the BOOST *replaces* the move action rather than being one increment of it, so "at the start of any straight-line increment" and "it can continue moving after a BOOST" are not modelled. Astartes is complete — two extra actions plus the now-live counteract clause. **MALICIOUS NARCISSISM is partial**: the "cannot counteract until that operative is expended" half is enforced through `onCounteract` (bound at a lower priority than the Astartes widening, so the veto still wins); "you can skip your activations" needs an activation-order seam. **SLICE THE VEIL is reminder-only** — there is no reserve/off-killzone state and no decision channel at deployment, and every clause hangs off that first choice. MURDEROUS DESCENT refunds the CP and un-marks itself when no legal Charge exists; its close-quarters "different room" variant is reminder-only (rooms are not modelled). Path to Damnation attempts a Boon on a deterministic, logged policy; Chaos Champion takes its Challenge target from the gambit's `data` with a logged default (D-016). |
| **phobos-strike-team** | pinned | ✅ shared validator | 4/4 | 4/4 | 3/4 | 3/4 | 2/2 | 10/18 | Custom ✅ Detonate ✅ | 41 | ✅ 2 maps | The Explosives and Haywire Mine markers are **real carried markers** created at deploy, each with its own Pick Up / Place action, so "cannot be placed within an enemy operative's control range" and the free Dash on placement are enforceable — **this closes the Kasrkin carried-marker-mine gap**. Detonate is fully implemented: the shot goes through the point-blank path with its Hit penalty cancelled, victims within 2" of the marker are queued exactly as Blast secondaries (Heavy terrain wholly intervening excluded, cover and obscured cleared), and the marker is removed; only "in an order of your choice" is deterministic. Custom is a pure setter (`setCustomWeaponRules`, D-017). Astartes is complete, counteract clause included. Reminder-only or partial: Omni-Scrambler's "cannot be activated" (no activation-refusal seam — the action ban is enforced and is stricter); Tactical Advantage's initiative re-roll (`rerollOffered` is never consulted) and its Command Re-roll discount (Command Re-roll never emits `onPloyUsed`); Medic!'s "must end that move within this operative's control range"; Track Target's guard state; Proximity Mine's "end its action"; Grav-chute and Grapnel Launcher on both REIVERs (`onMoveRules` is never emitted); STEALTH ASSAULT's extra dice resolution; PURITY SEALS' fighting/retaliating half (`onRollAttack` is shoot-only). |
| **deathwatch** | pinned | ✅ shared validator (leader `inList`) | 1/2 (+1 partial) | 4/4 | 4/4 | 3/4 | 0/0 | 9/13 | PhaseSweep ✅ Shield ✅ | 40 | ✅ 2 maps | Veteran Astartes' two Shoot / two Fight actions are two extra `ActionDef`s that also charge the printed "1 additional AP" surcharge, and "can counteract regardless of its order" is now **live**; its other counteraction clause — the extra free 1AP action during a counteraction — stays reminder-only, because the reducer hard-codes one action per counteraction with no hook. Special Issue Ammunition is a `Shoot (Special Issue Ammunition)` action whose six ammunition types are parsed out of the printed rule text; AMMUNITION RESERVE widens its once-per-TP allowance to two different rules, once per battle. Phase Sweep is a four-link chain of its own `Fight (Phase Sweep …)` actions, each refusing an enemy already swept this activation. Adaptive Swordsmanship's "that success must be used to block" is unenforceable (the engine builds the strike/block options) and Advanced Omni-Scrambler's "cannot be activated" is unenforceable; both are implemented for everything else. Reminder-only: Adaptable Armoury (the reducer caps equipment at four before any hook), Grav-chute and Grapnel Launcher, and the Scrutavore Servo-Thrall's mission-action exemption (`canPerformAction` can only forbid). |
| **wolf-scouts** | pinned | ✅ shared validator | 1/2 (+1 partial) | 4/4 | 4/4 | 4/4 | 2/3 | 7/11 | PSYCHIC ✅ (keyword only) | 40 | ✅ 2 maps | Everything hangs off one per-player `wolf-scouts.storm.<player>` marker: Elemental Storm places it as a 0CP gambit, "within your STORM" is base-to-marker ≤6" and "wholly within" is `dist + baseRadius − markerRadius ≤ 6`, and eight other rules read it. Conceal-order charges are two extra `treatedAs: 'Charge'` actions. Hunting Astartes' second Shoot is **two** actions — 1AP and a 2AP plasma variant — because `onActionCost` cannot see the weapon, so the printed "1 additional AP if both actions use a plasma gun or plasma pistol" is carried by the action's own AP. **Hunting Astartes is still partial**: "can counteract regardless of its order" is now live, and "change its order instead of performing an action" is a 1AP `Change Order (Hunting Astartes)` gated to counteracting inside the STORM, but "you can change its order **first**" (and then still act) has no seam. Grizzled Veteran is complete. Spiritual Chirurgy cancels the injured penalties through `onStatMod` and survives the FANGBEARER's death. Cast the Runes banks CP and discounts the Command Re-roll — **shoot attack and defence only**, since `fight.ts` offers its re-rolls without emitting any hook. Haywire Mine is partial and **Proximity Mine (the detonation) is reminder-only**: `checkMines` lives inside `applyMove` and emits no hook. |
| **legionary** | pinned | ✅ shared validator | 2/2 | 4/4 | 4/4 | 3/4 | 1/1 | 10/11 | PSYCHIC ✅ (tag only) SiphonLife ✅ | 44 | ✅ 2 maps × 2 equipment sets | Marks of Chaos is a pure setter (`setMarkOfChaos`, D-017) and nothing applies until it is called; all five keywords bound. Astartes is complete — two extra actions plus the now-live counteract clause. CHAOS TALISMANS is **partial**: it raises a real PendingDecision from `onRollAttack` that discards a fail, retains another as a normal success and inflicts the D3 — but only when shooting, because `fight.ts` emits no post-roll hook. Devastating Onslaught is partial: enemies cannot assist and the free Charge is D-015 extra AP capped at 2", but "must end that move within control range of *that selected* operative" has no seam. Daemonic Aura pre-rolls its D6 at `onActivationStart` (rolling inside `canPerformAction` would burn RNG outside the reducer), so it does not cover a counteraction. Unleash Daemon and Infernal Pact are real PendingDecisions answered through `decisionHandlers`, with "Not yet" first so the deterministic default is to decline. UNENDING BLOODSHED is paid for during the fight and pays out inside `onIncapacitated` — the effect is exact, the moment of purchase is shifted. GRISLY MARK places its marker as printed, but **the JSON gives that marker no effect at all** — see the data problems below. |
| **nemesis-claw** | pinned | ✅ shared validator | 2/2 | 3/4 | 3/4 | 2/4 | 3/3 | 8/9 | Terrorchem ✅ | 37 | ✅ 2 maps | Astartes is two extra actions (the second gated on a bolt pistol / boltgun / scoped bolt pistol having been selected for one of them) plus the now-live counteract clause. In Midnight Clad sets `seq.obscured` at `onCollectAttackDice`, which still precedes the retention and obscured-discard steps. Terrorchem tokens are per-player effects on the bearer; the vial tokens through Devastating alone because its Critical Dmg is 0, and the D3-on-activation half is printed under a **mis-titled "POISON OBJECTIVE" ability** (data bug below). Screecher strips Balanced/Ceaseless/Relentless from enemy weapons at priority 45 and clears every shooting re-roll grant; only a Command Re-roll spent in a **fight** survives, because `fight.ts` never emits `onRollAttack`. PREYSIGHT auto-uses only when the target is already within 6", where its Range 6" half costs nothing. RETURN TO DARKNESS grants the free action and the 4" cap; its "must end with Heavy terrain within control range / underneath Vantage" and "cannot end closer to enemy operatives" clauses are reminder-only (no hook constrains a move's end position). VOX SCREAM's "cannot activate it during this activation" is modelled as −1 APL (the engine cannot refuse an activation — the VISION OF MADNESS substitution). PROCLIVITY FOR MURDER is two extra ActionDefs (D-021, so the AI cannot use them). WE HAVE COME FOR YOU resolves its D3 at the end of the activation rather than at the end of the Charge move (no post-action hook). CHAIN SNARE rolls when the snared operative is **activated**, not when it declares the Fall Back (`canPerformAction` is a pure query). |
| **warpcoven** | pinned | ⚠ shared validator — the printed `custom` SORCERER requirement and both `maxItem` weapon caps have **no branch in `validateRosterFor`**, so they are silently unenforced (`defaultRoster` is legal and does include a SORCERER) | 2/2 | 3/4 | 3/4 | 3/4 | 5/6 | 11/11 | Mindburn ✅ PSYCHIC ✅ Shield ✅ | 45 | ✅ 2 maps | The nine BOONS OF TZEENTCH are sliced out of the one printed faction rule at module load and chosen through the pure `setBoon` setter — Select Operatives still has no decision channel, so nothing applies until a boon is chosen. Eight boons are hooks; **Echoes from the Warp is reminder-only** (the reducer hard-refuses a counteracting operative's second action, and there is no order-change seam at that moment). Immaterial Flight is two `treatedAs` actions; Mutant Appendage is `Pick Up Marker (Mutant Appendage)` — its **"or mission actions" half is reminder-only**, because ops own those ActionDefs and a team cannot wrap them. Astartes is complete, counteract clause included. Mindburn tokens go through `onStatMod` (never the dead `StatMods.hit`) and are not cumulative with injured. **RAVAGE DESTINY is partial** — the forced "re-roll results of 6" works when shooting; the fighting/retaliating half is unreachable. **FATE ITSELF IS MY WEAPON is partial** — the 2D6 reserve, the "<9 discards the other" rule and the end-of-TP discard are real, but the *optionality* is not: a reserved dice is spent automatically and logged when it strictly helps (D-016). **MUTANT HERD is partial** — the pairing is recorded as an effect for the UI/AI, the same partial as Breach and Clear and Group Activation. SORCEROUS SCROLLS raises a real BOON-swap decision through `decisionHandlers` at activation; its "or counteracts" half is reminder-only (Counteract emits no hook). |

All sixteen batch-1 and batch-2 teams are implemented. `tests/teams/selection.test.ts` covers every
team's printed selection requirements, and `tests/teams/soak.test.ts` rings each batch separately
(8 pairings × 2 maps per batch) with zero rejected intents.

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
| **Batch 2** — `onCounteract` is emitted **before** the Engage-order test, which becomes the event's default (`allowed: o.order === 'engage'`) instead of a pre-filter; `whoActivates(state, ctx?)` consults `counteractCandidates` when given a context (`src/core/phases.ts`) | "This operative can counteract regardless of its order" — printed on the Astartes faction rule of **twelve** kill teams (ten implemented). The hook could previously only *narrow* the list the core had already computed, so every one of those clauses was unreachable, and batch 1 shipped Angels of Death and Plague Marines with the handler registered but inert — the silent no-op architecture rule 5 forbids. `whoActivates` had to move with it or the candidate list and the turn test would disagree; as a side effect the two now also agree about the On Guard lockout, which `whoActivates` did not previously check. |

## Data problems found while implementing batch 2

Implementing a team is the only thing that reads every byte of its JSON, so each batch finds
scraper bugs. These are **in the committed data**, not in the modules:

- **The section overrun hits all 48 of 48 teams.** Every team's LAST strategy ploy has the entire
  "Firefight Ploys" section appended to its `text`, and every team's LAST firefight ploy has the
  entire "Faction Equipment" section appended — thousands of characters where a hundred belong.
  `trimTrailingSection` in `src/teams/data.ts` cuts both at the heading, so the app and the
  modules quote the right text, but **the committed JSON is wrong for every team** and any
  consumer reading the file directly gets a page dump. The load-time patch is a workaround; the
  fix belongs in `tools/teams/normalise.py`, at the missing terminator for the final item of a
  section. The same overrun also drags a stray `weapons: []` array from the following equipment
  entry onto those two ploys in several teams.
- **`deathwatch`: "up to one GRAVIS operative" was unenforceable and the default roster broke
  it.** GRAVIS is a datacard keyword shared by three list rows, not a selection role, so the
  validator's role match never fired and `defaultRoster` produced a two-GRAVIS kill team it then
  accepted. **Fixed** in `src/teams/selection.ts`: a `maxCount` whose role matches no list row
  falls back to a keyword match. Pinned by a test.
- **`nemesis-claw`: an ability is mis-titled and its rare rule is truncated to match.**
  `nemesis-claw.night-lord-fearmonger.poison-objective` is named "POISON OBJECTIVE" but its text
  is the second sentence of **Terrorchem** ("Whenever an operative that has one of your Terrorchem
  tokens is activated, inflict D3 damage on it."). The real POISON OBJECTIVE action is separately
  and correctly present. `_rare-weapon-rules.json`'s `Terrorchem` definition stops one sentence
  early to match — compare `Poison`, which carries both sentences.
- **`wolf-scouts`: HUNTER'S SENSES is truncated.** The text ends at "Select one of the following
  rules for this operative's instigator bolt carbine to have…:" with the bullet list absent, so
  the selectable rules cannot be pinned. `notes[]` is `[]` and `validate.py` did not flag it —
  `docs/TEAM-DATA.md` § "What the source did not give us" should gain a `wolf-scouts` row.
- **`legionary`: GRISLY MARK places a marker with no printed effect.** The action text is only
  "Place your Grisly marker within this operative's control range" plus its restrictions, and
  nothing says what the marker does, though `markerGuide` lists the token. Likely a dropped
  SHRIVETALON datacard clause — worth checking the October '25 PDF.
- **`_rare-weapon-rules.json`: `Detonate` is stored with one team's wording.** The definition says
  "your **Mine** marker" throughout (the Imperial Navy Breachers' text), but the Phobos Strike
  Team datacard prints "your **Explosives** marker". Detonate is per-team text, so the shared
  registry entry shows a Phobos player the wrong marker name.
- **`uniqueActions[].keywords` is never populated by the scraper.** Several actions begin
  "PSYCHIC." in their text, but the field the schema provides for it is empty everywhere, so no
  rule can filter on PSYCHIC actions — anti-psyker rules and the Celestian Insidiants' PSYCHIC
  carve-out cannot see them.
- **`warpcoven`: the `^3` half-selection cap looks wrong.** `{kind:'halfSelection', group:'^3',
  max:1}` caps a Warpcoven kill team at two TZAANGOR operatives in total, but four entries carry
  the footnote and its wording is the two-entry form used by the Kommandos GROT + BOMB SQUIG pair.
  **Worth a human check against the card** — if each TZAANGOR simply costs half a selection, `max`
  should be the group's own count.
- **`murderwing`: equipment-granted unique actions are unstructured.** SLICE FROM ABOVE, CLAWED
  CHARGE and VOX-CRY are run-together strings inside the equipment `text` ("SLICE FROM ABOVE1AP\n…")
  with no id/name/ap, unlike datacard `uniqueActions`. A `uniqueActions: []` array on equipment
  entries would let a module use the `uniqueAction()` helper instead of re-deriving AP from prose.
- **Several teams have a null `selection.leader.role`/`datacardId`** while `leaderList` holds the
  real entries (phobos-strike-team, legionary, warpcoven). Cosmetic — the validator copes — but a
  roster error reads "exactly 1 LEADER operative" instead of naming the role.
- **Checked and NOT bugs**, recorded so a future re-scrape diff is not "fixed": Melta bomb 5/3,
  Skysear meltagun 6/3, Doombolt 4/2 and the Terrorchem vial's `dmgC: 0` all have Critical Dmg at
  or below Normal Dmg. That is how KT24 prints weapons whose crit pays out through Devastating.

## Bundle size

`data/teams/**` is code-split by `src/ui/data.ts` (dynamic import per team), but **a team added to
`src/teams/data.ts` is also statically imported**, and Vite warns that a statically-imported module
cannot move into another chunk. So every implemented team's JSON lands in the main bundle: it was
552 kB / 135 kB gzipped at the end of batch 1 and is **852 kB / 193 kB gzipped** with batch 2's
eight teams in. The remaining 32 teams will roughly double it again on the current trajectory.
`teamData()` is synchronous and every module calls it at import time, so fixing this means making
team data async or generating a small per-team static slice — a real design change, flagged here
rather than papered over.

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
- **`fight.ts` emits no post-roll hook at all.** `offerRerolls` builds its grants from
  Balanced/Ceaseless/Relentless plus Command Re-roll and never emits `onRollAttack`, which
  `shoot.ts` does emit. **Six of the eight batch-2 teams reported this as their top missing
  seam** — Scout Squad's Designate Target, Wolf Scouts' Cast the Runes, Legionary's CHAOS
  TALISMANS, Nemesis Claw's Screecher, Warpcoven's RAVAGE DESTINY and FATE ITSELF IS MY WEAPON,
  and Phobos' PURITY SEALS each print "shooting, fighting or retaliating" and each works only
  when shooting. **It was deliberately NOT added in batch 2**: 15 of the 17 existing
  `onRollAttack` handlers across both batches do not guard on `ev.ctx.type`, so emitting it in
  fights would silently change melee behaviour for all of them — some would become more correct,
  others would start firing where their printed rule says shooting only. It needs its own change
  with all 17 handlers audited, and it is the highest-value seam left.
- **A mandatory re-roll cannot be expressed.** Every `RerollGrant` is offered as an optional
  decision with a `keep` option, so "your opponent **must** re-roll their attack dice results of
  6" (Warpcoven's RAVAGE DESTINY) has to re-roll the pool itself inside the hook. A
  `forced?: boolean` + `value?: number` on `RerollGrant` would fix it.
- **There is no marker-trigger hook.** `checkMines` is inside `applyMove` (`src/core/actions.ts`),
  hard-wired to `kind: 'mine'`, D3+3 damage and any player, and emits nothing. Every team mine —
  Kasrkin's Melta/Proximity Mine, Scout Squad's Booby Trap, Phobos' and Wolf Scouts' Proximity
  Mine — therefore springs at an activation boundary rather than mid-move, so the printed "end its
  action" can never be honoured. Phobos **did** close the other half of the Kasrkin gap: a mine is
  now a real carried marker with its own Pick Up / Place actions.
- **`onMoveRules` being unemitted is now the single most-cited gap** (4 of 8 batch-2 teams):
  Murderwing's Jump Pack, both Phobos REIVERs' and the Deathwatch Headtaker's Grav-chute and
  Grapnel Launcher, and Scout Squad's Grapnel Launcher all need per-leg climb/drop control.
  `validateMove` keeps its `legs` (which know climb/drop/jump) to itself.
- **Nothing runs at the end of an action**, so "at the end of that action" rules are bounded to
  the activation instead (Legionary's MALIGNANT AURA, Nemesis Claw's WE HAVE COME FOR YOU,
  Murderwing's WARP FUEL).
- **`validateRosterFor` has no branch for `kind: 'custom'` or `kind: 'maxItem'`.** Warpcoven is
  the first implemented team with either, and both are silently unenforced. `maxItem` also appears
  in canoptek-circle, hunter-clade, void-dancer-troupe, hand-of-the-archon, sanctifiers, xv26 and
  death-korps, so it is worth doing data-driven in the shared validator rather than per team.
- **A unique action's target legality must live in `check`, not `perform`.** `src/ai/legal.ts`
  `missionCandidates` offers friendly AND enemy targets and only re-runs `def.check`, so anything
  `perform` refuses becomes a rejected intent. Found twice while soaking batch 1's second half —
  once in this batch's own SPEAK OF HER DEEDS, and once in Plague Marines' POISONOUS MIASMA
  (`check` accepted any `targetOperativeId`, `perform` then refused a friendly one); both now
  validate in `check`. Worth a lint: no `perform` should return a reason its `check` cannot.
