# Rules audit — the plan for what is still open

The nine items still open in `docs/RULES-AUDIT.md`, each with the rule it turns on, the question
only the repo owner can answer, and a plan that has been through an adversarial verifier.

This is the **working** version: what you need in order to do the work. The verification pass that
produced it ran ten agents (five investigators, five verifiers briefed to refute them) over ~2M
tokens, and the unabridged output — every reproduction, every objection in full, and the original
plans the verifier rejected — is permanently in git history:

```
git show 6164462:docs/RULES-AUDIT-PLANS.md
```

Two rules for using this document.

**Read the OWNER paragraph first.** Nothing here can land without one, and several are the same
shape as D-101's parapet: the cards simply do not print the number.

**Where a corrected plan is given, it supersedes the original.** The verifier rejected eight of the
twelve plans with run-backed objections; those corrections are what appears below.

Every finding was proved by running code, not by reading it — a standard set because three of the
original audit's own claims failed it. Those corrections are noted per item.

| Item | Effort | Blocked on owner |
| --- | --- | --- |
| W-18 | medium | yes |
| W-21 | medium | yes |
| W-22 | medium | yes |
| W-23 | medium | yes |
| W-28 | medium | yes |
| W-29 | large | yes |
| W-32 | large | yes |
| W-33 | large | yes |
| W-36 | large | yes |

---

## W-18

*Effort: medium*

### The rule

```
docs/rules-source/core-rules.txt:282-289, Charge 1AP, verbatim:
  282: "Charge1AP"
  283: "The same as the Reposition action, except the active operative can move an additional 2\"."
  285: "It can move, and must finish the move, within control range of an enemy operative. If it moves within control range of an enemy operative that no other friendly operatives are within control range of, it cannot leave that operative's control range."
  287: "An operative cannot perform this action while it has a Conceal order, if it's already within control range of an enemy operative, or during the same activation in which it performed the Reposition, Dash or Fall Back action."
The same sentence recurs verbatim at core-rules.txt:721, killzones.txt:674, appendix.txt:307, approved-ops-2025.txt:351, the-missions.txt:552, volkus-compound.txt:399, tomb-world.txt:1129, typhon.txt:762, deadly-sniper.txt:356, universal-equipment.txt:259, airborn-assault.txt:283, blood-and-zeal.txt:279 — always inside the Charge paragraph, never with a duration.
Contrast core-rules.txt:277-279 (Fall Back): "the active operative can move within control range of an enemy operative, but cannot finish the move there" — no sticky clause, so the set must be built for Charge only.
```

### The original audit entry is wrong about this

Core claim CONFIRMED, but four things are wrong or stale.

(1) Line numbers: the sticky computation is now src/core/actions.ts:309-312 (not :252); the `if (opts.mayEnterEnemyControlRange) continue;` that discards the mid-path knowledge is src/core/movement.ts:396.

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Keep steps 1-4, 6, 7, 9, 10 as written. Replace step 5: `enemyProbes` must NOT early-out when the caller needs sticky tracking — change the guard to `if (opts.mayMoveThroughEnemies && opts.mayEnterEnemyControlRange && !opts.mustFinishEngaged) return [];`, so a BARGE Charge still walks the per-enemy loop (the base-overlap test inside it is already skipped by `!opts.mayMoveThroughEnemies`). Justify it with BARGE's own sentence "(but then normal requirements for that move apply)" from data/teams/gellerpox-infected.json, and with D-072, not with Blades of Khaine or the Brood Brother familiar. Add a test: a BARGE-flagged Charge that clips an unscreened third enemy and finishes elsewhere is rejected, while the same operative leaving the control range of the enemy it STARTED engaged with is accepted.

Replace step 3's end-of-move loop with a during-the-move test, which is both stricter and correct: in `enemyOnTheWay`, do not `break` after `sticky.add(enemy.id)` on the increment that adds it; instead record it and, on every subsequent sample for that enemy (this increment and later ones, since the Set persists across the waypoint loop), fail with `cannot leave the control range of ${enemy.letter}` the first time `withinControlRange(index, here, eBody)` is false. Keep the end-of-move test as a cheap backstop for the final position only. If the owner prefers to keep the cheap approximation for performance, say so explicitly in DECISIONS.md as an accepted under-enforcement with the leave-and-return case named — do not ship it silently.

Add to the owner question: the plan's step 4/7 still leave `stickyEngagedWith` written and never read under the recommended within-move reading; decide delete-vs-diagnostic in the SAME change, not later.

**Why the original plan was rejected.** LIVE — confirmed by my own run of the investigator's /tmp/.../scratchpad/w18.test.ts: `validateMove ok=true`, charger lands at (15.8,11), `stickyEngagedWith=["p2-1"]`, A (p2-0) never recorded, and a later clean Fall Back off the sticky enemy is accepted with the flag unchanged. `grep -rn stickyEngagedWith src/` = 14 writes + 1 initialiser (reducer.ts:140) + 1 type (types.ts:332) + 1 comment (gellerpox-infected/index.ts:205), zero reads. Rule reading (within-the-move, not persistent) is correct: 13 occurrences of the sentence across 12 corpus files (core-rules.txt:285 and :721 plus 11 others), never with a duration clause. No DECISIONS.md entry covers charge stickiness.

*(Full objection in the git blob above.)*

### Test

One new describe in tests/rules-review.test.ts quoting core-rules.txt:285 verbatim. Board: the existing `battle()` harness on testMap(), 32mm test.trooper cards, p1 = [charger, mate], p2 = [A, B]; charger (10,11), A (12.5,12.6), B (18,11); Charge declared to (15.8,11). These exact coordinates are the ones I proved with and satisfy every precondition at once: charger-A start gap 1.708 (not engaged, so Charge's own check passes), closest mid-path gap to A 0.340 (clipped), end gap to A 2.408 (left), end gap to B 0.940 (finished engaged), 5.8" charged 6" against budget 8".

  it('...it cannot leave that operative's control range') — mate at (4,4). validateMove with {action:'Charge',bonusInches:2,mayEnterEnemyControlRange:true,mustFinishEngaged:true} returns ok:false matching /cannot leave the control range/, and the same intent through the reducer lands in state.rejected with the charger still at (10,11).
  it('...unless one or more other friendly operatives are already within control range') — mate at (12.5,14.4) (inControlRange(mate,A)===true, gap 0.540); the identical Charge is ok:true and lands at (15.8,11).
  it('the sticky set is the path, not the destination') — mate at (4,4), A moved to (40,40); Charge through the reducer, assert stickyEngagedWith === [B.id]. Then A back at (12.5,12.6) with a Charge that finishes inside A's control range: assert BOTH ids in a stable order.
  it('an enemy it was ALREADY within control range of is not one it moves within control range of') — drive a BARGE-shaped Charge from an already-engaged start and assert that enemy is absent from v.sticky.
  In tests/teams/gellerpox-infected.test.ts, quoting "enemy operatives can leave MUTOID VERMIN operatives' control range when performing the Charge action": the same clip-and-leave Charge is REJECTED when A is ordinary and ACCEPTED when A is a MUTOID VERMIN; assert the clause is no longer in the module's REMINDER_ONLY map.

Re-run `pnpm test tests/soak` and the 13 team files that call playGame. Expect zero rejected intents and at most a handful of seeded games to diverge — my instrumented run found exactly 1 illegal Charge in 108 games. Re-baseline anything that moves with the reason recorded, per the D-102 precedent.

### Risk

Lower than the audit states, and measured rather than guessed.

- No rejected intents can appear from the AI: buildPath (src/ai/moves.ts:250-254) only returns a candidate whose path validateMove accepted, so the soak's `expect(rejected).toEqual([])` is safe.
- Fixture drift: 1 illegal Charge in 108 instrumented soak games, so few seeded replays should change. Not zero — the AI may pick a different landing cell when its first-choice path becomes illegal, and that cascades through the RNG cursor for the rest of that game.
- Performance: enemyOnTheWay now runs two visibility sweeps per near-path enemy on Charges, which the line-396 short-circuit was avoiding. Bounded by the `near > reach` cheap rejection above it, applies to Charges only, and reachableCells (the AI flood fill) never calls enemyOnTheWay, so move previews and AI search are untouched.
- No existing test asserts stickyEngagedWith. The exposure is instead team Charge fixtures that happen to route past a third operative; tests/teams/harness.ts `chargeTo` builds a straight approach line, so any such fixture needs a waypoint or a nudge — exactly the D-102 shape.
- If the owner picks the PERSISTENT reading the risk jumps a lot: every later move must consult the set, the 13 team writers become load-bearing, and the field must be cleared on Fall Back / set-up-again / the enemy's removal — none of which happens today (proved: the flag survives a clean Fall Back).

### OWNER — this cannot land without an answer

Yes, and not covered by any existing entry — docs/DECISIONS.md has nothing mentioning Charge stickiness (D-050, D-072, D-081 and D-102 cover the neighbouring movement work and none touch this).

The question: does "it cannot leave that operative's control range" bind only the Charge move, or persist afterwards?
For within-the-move (my recommendation): the sentence lives inside the Charge paragraph; the corpus carries it 13 times with no duration clause; every printed exemption is Charge-scoped ("...to do so", "...when performing the Charge action"); and the persistent reading would make Fall Back — the action whose whole purpose is disengaging — illegal against a solo charge target for the rest of the battle.
Against: the codebase assumed persistence. src/core/types.ts:332 calls it "Set while the operative is in a Charge that made it the sole engager", and five team modules deliberately CLEAR it on teleport / go-underground / free Fall Back (tempestus-aquilons:306, raveners:475, void-dancer-troupe:869, corsair-voidscarred:1312, murderwing:952), which only makes sense if something were meant to read it later.

The owner must also say what happens to the field. Under the within-move reading `op.stickyEngagedWith` has no consumer: either delete it (with the 13 writes and 5 clears) or keep it as a logged diagnostic with a comment saying it is not a rule input. Leaving it written-and-unread is the silent no-op CLAUDE.md rule 5 forbids, and gellerpox-infected/index.ts:205 already says so out loud.

### Files

`src/core/movement.ts`, `src/core/actions.ts`, `src/core/hooks.ts`, `src/teams/gellerpox-infected/index.ts`, `src/teams/goremonger/index.ts`, `src/teams/warpcoven/index.ts`, `src/teams/murderwing/index.ts`, `src/teams/canoptek-circle/index.ts`, `src/teams/chaos-cult/index.ts`, `src/teams/corsair-voidscarred/index.ts`, `src/teams/farstalker-kinband/index.ts`, `src/teams/sanctifiers/index.ts`, `src/teams/hearthkyn-salvager/index.ts`, `tests/rules-review.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`


---

## W-21

*Effort: medium*

### The rule

```
docs/rules-source/core-rules.txt:374-379, the Fight sequence, verbatim:
  374: "1. Select Enemy Operative"
  375: "The attacker selects an enemy operative within the active operative's control range to fight against. That enemy operative will retaliate in this action."
  376: "2. Select Weapons"
  377: "Both players select one melee weapon () to use that their operative has and collect their attack dice — a number of D6 equal to the weapon's Atk stat."
  379: "If a rule says an operative cannot retaliate, then they can still be fought against, but attack dice cannot be collected or resolved for them."
Line 377 is unambiguous that the selection belongs to BOTH players and that the selected weapon's Atk sets the pool size; line 379 is the only carve-out and is already honoured by seq.defenderCanRetaliate.
```

### The original audit entry is wrong about this

The headline is right — the defender still gets no choice — but six specifics are wrong.

(1) THE FLAGSHIP EXAMPLE IS DISPROVED. "A Blooded Traitor Chieftain always retaliates with its Bayonet" is false in any game where a loadout was selected. data/teams/blooded.json gives the CHIEFTAIN four loadout options — "Autopistol or laspistol; chainsword or power weapon" / "Bolt pistol; chainsword" / "Boltgun; bayonet" / "Plasma pistol; improvised blade" — each with exactly ONE melee weapon. Run through tests/teams/harness.ts (which calls applyLoadouts) `weaponsOf(ctx,s,chief,'melee')` returns a single weapon, Chainsword, and there is nothing to choose.

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Step 2: filter profiles with the already-exported `weaponExhausted(op, w, p)` (src/core/state.ts:278) as well as relying on `weaponsOf`'s weapon-level filter — `w.profiles.filter(p => p.type === 'melee' && !weaponExhausted(op, w, p))`. Keep the Brood Brother Medic test AND add a Breaka Boy Demolisha test that spends Detonate and asserts only "bash" is offered on the next retaliation.

Step 5: put the numbers in the option payload — `data: { weaponName, profileName?, atk, dmgN, dmgC }` — so `defaultDecisionOption` can pick `max(Number(o.data?.atk ?? 0))` with ties by array order, and so the AI arm in step 6 does not have to re-derive them either.

Step 3: do not raise the decision blind. Add `seq.defenderWeaponForced?: boolean`, set it wherever a rule writes `seq.defenderWeapon` (pathfinders/index.ts:583 today), and skip the selectWeapons decision when it is set. Alternatively re-derive `meleeOptionsFor` inside the `case 'selectRetaliationWeapon'` arm of `resolveDecision` and reject an option that is no longer available — but the forced-flag is simpler and is what the plan's own regression bullet actually needs. Also fix the plan's characterisation: POINT-BLANK FUSILLADE is currently unreachable in a real game, so its "regression" test is really a first-time enablement and should say so.

Everything else in the plan stands. Do NOT use the Blooded Traitor Chieftain as the positive fixture (its loadout leaves one melee weapon — the audit's example is genuinely disproved); the Brood Brother Magus is the right one. Owner question 2 (should the AI/soak path record loadouts) is the one that actually sizes this item and should be answered before the fixture re-baseline is paid.

**Why the original plan was rejected.** LIVE — I re-ran /tmp/.../scratchpad/w21b.test.ts myself: a Brood Brother Magus fielded through tests/teams/harness.ts (which does call `applyLoadouts`, at harness.ts:100) with the validated loadout ["Autopistol","Bio dagger","Force stave"] retaliates with the Bio dagger (A2) and never the Force stave (A4); `pending after startFight: []`, defender pool 2 dice, the only decision raised is the attacker's reroll. src/core/sequences/fight.ts:63 `const dw = weaponsOf(ctx, state, defender, 'melee')[0];` with the stale comment above it. Rule quote checked verbatim at core-rules.txt:374-379.

*(Full objection in the git blob above.)*

### Test

tests/rules-review.test.ts, one describe quoting core-rules.txt:377 verbatim. Do NOT use the Blooded Traitor Chieftain — I proved its loadout leaves exactly one melee weapon, so the audit's suggested test would assert a decision that must not be raised. Use the Brood Brother Magus, which I proved is fieldable with both:

  it('"Both players select one melee weapon to use that their operative has" — the defender chooses too') — teamContext([broodBrother]) + rosterIncluding(broodBrother, ['brood-brother.magus']), battle(), attacker at (12,11), Magus at (13.2,11), everyone else parked off-board. Assert weaponsOf(ctx,s,magus,'melee').length === 2; startFight + advanceFight; assert state.pending[0].kind === 'selectRetaliationWeapon', .who === 'p2', and that the options cover BOTH 'Bio dagger' and 'Force stave'.
  it('...and collect their attack dice — a number of D6 equal to the weapon's Atk stat') — resolve to Force stave: seq.defenderWeapon === 'Force stave', sideWeapon(...,'defender').profile.atk === 4, seq.defenderPool.dice.length === 4 (today 2). Resolve a second run to Bio dagger: 2.
  it('no decision when there is nothing to choose') — the Blooded Traitor Chieftain under its printed loadout, which doubles as a regression test for the audit's mistaken example: no 'selectRetaliationWeapon' in pending and the fight rolls straight through.
  it('"If a rule says an operative cannot retaliate"') — push a `cannotRetaliate` effect on the Magus: no decision, empty defenderPool.
  it('a Limited profile already exhausted is not offered') — Brood Brother Medic (Bayonet + Gene-needler, Limited 1): once the Gene-needler is exhausted the decision is not raised at all.
  tests/teams/pathfinders.test.ts regression: POINT-BLANK FUSILLADE's write to seq.defenderWeapon (index.ts:583) must still win — assert the granted "(point-blank)" weapon is the one rolled.

Then re-run every file that plays whole games and re-baseline what drifts: tests/teams/{celestian-insidiants,wrecka-krew,tempestus-aquilons,kommandos,hierotek-circle,ratlings,exodite-dragon-masters,fellgor-ravager,gellerpox-infected,hunter-clade,blooded,murderwing}.test.ts.

### Risk

Medium, and now sized precisely.

Because AI games never apply loadouts, the decision fires for the RAW 64-card set in every AI-driven test. I measured which default rosters contain a raw multi-melee card: celestian-insidiants (Insidiant Abjuror), wrecka-krew (Wrecka Boss Nob, Breaka Boy Demolisha), tempestus-aquilons (Aquilon Tempestor), kommandos (Kommando Boss Nob), hierotek-circle (Chronomancer), ratlings (3x Bullgryn), exodite-dragon-masters (all three Dragon Masters), fellgor-ravager (Fellgor Ironhorn), gellerpox-infected (Bloatspawn, Fleshscreamer, 3x Mutant), hunter-clade (Sicarian Infiltrator Princeps + 4 Warriors), blooded (Traitor Chieftain, Traitor Corpseman), murderwing (Chaos Lord, Champion) — 13 of the 17 team files that call playGame. raveners, battleclade, pathfinders, chaos-cult and goremonger are clean, and tests/soak/soak.test.ts + tests/ai.test.ts use synthetic ai.* cards with one melee weapon each, so the headline soak is untouched.

What drifts is the dice: changing the defender's weapon changes Atk, which changes how many D6 come off the RNG, which shifts the cursor for the rest of the game. Expect assertion churn in those 13 files rather than logic failures; mitigate with the D-102 precedent (move the fixture, record why, re-seed only where the perturbed game makes an assertion vacuous rather than wrong).

Smaller risks: (a) 62 startFight call sites across src/ and tests/; the five in src (core/actions.ts, core/reducer.ts, teams/{wyrmblade,farstalker-kinband,exodite-dragon-masters}) all follow with advanceFight and already tolerate a pending decision, because advanceFight's loop condition is `state.pending.length === 0`. (b) Any test asserting an exact `state.pending.length` right after a Fight sees one more. (c) The decision is asked of the DEFENDER, so pass-and-play triggers the handover gate (src/ui/command/index.tsx:169) once per multi-melee fight — correct, but a new interruption the owner should see before it ships.

No rejected intents: the AI answers every decision offered (src/ai/agent.ts:93, src/ai/baseline.ts:44) and decideOption only ever returns an id the decision offers.

### OWNER — this cannot land without an answer

Yes — three questions, none covered by an existing entry. docs/DECISIONS.md has no decision about retaliation weapons; the nearest precedent is D-022 ("'You can use this rule' is auto-used on a stated, deterministic policy when it is free, and raised as a PendingDecision when it costs something").

1. Full blocking decision (rules-faithful — core-rules.txt:377 makes it a player choice) or a deterministic best-profile default under D-022? For the decision: the choice genuinely costs something in at least three fielded cases — Sanctifier Miraculist's Burning hands is Limited 1, Deathwatch Blademaster Veteran's second Xenophase blade profile is a Phase Sweep mode, Wrecka Krew Breaka Boy Demolisha's second Tankhammer profile is a 0/0 Limited-1 Detonate. A blind maximiser burns all three. Against: one extra reactive window per multi-melee fight. Note the "cheap interim" is not cheaper in fixture cost — both options change the dice count identically.

2. The one that actually sizes this item: should the AI/soak path record loadouts? Today src/ai/runner.ts:93 dispatches SelectRoster and never calls applyLoadouts, so AI games field operatives carrying every weapon printed on the card — which is what inflates this from 17 datacards to 64, and is a rules problem in its own right (an operative fighting with a weapon it did not select). I could not find it filed anywhere. If the owner wants it fixed, do it BEFORE or WITH W-21, or the fixture re-baseline is paid twice.

3. Data, low stakes: should a selection entry combine a `loadouts` row with `optionGroups`? angel-of-death Assault Intercessor Sergeant currently yields Hand flamer + Plasma pistol + Chainsword + Power fist that way. If that is a scrape bug it belongs in tools/teams, and the fieldable count drops from 26 to 17.

### Files

`src/core/sequences/types.ts`, `src/core/sequences/fight.ts`, `src/core/decisions.ts`, `src/ai/decide.ts`, `src/ui/command/index.tsx`, `tests/rules-review.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`


---

## W-22

*Effort: medium*

### The rule

```
docs/rules-source/universal-equipment.txt:100 - "Razor wire is Exposed and Obstructing terrain. Before the battle, you can set it up wholly within your territory, on the killzone floor and more than 2\" from other equipment terrain features, access points and Accessible terrain."
docs/rules-source/universal-equipment.txt:102 - "Obstructing: Whenever an operative would cross over this terrain feature within 1\" of it, treat the distance as an additional 1\"."
docs/rules-source/killzones.txt:160 - "Operatives cannot move through terrain - they must move around, climb over or drop/jump off it."
docs/rules-source/killzones.txt:165 - "Operatives must finish a move in a location they can be placed - they cannot finish midway through a climb, drop or jump. If this isn't possible, they cannot begin the move."
The decisive reading: a rule that PRICES crossing ("treat the distance as an additional 1\"") presupposes that crossing is legal. Razor wire carries no size type (it is neither Light nor Heavy) - Obstructing is its whole movement rule, and it supersedes the general killzones.txt:160 prohibition for this feature. killzones.txt:165 is what keeps `solid` true: you may cross the wire but you may not end your move standing in it.
```

### The original audit entry is wrong about this

Substantially accurate, three corrections. (1) LINE NUMBERS HAVE MOVED: the surcharge is now computed at src/core/movement.ts:224-226 (audit says 192) and pathBlockedByTerrain is called at src/core/movement.ts:253 with a Wall check in between (audit says 'three statements later'). kit.ts:145 `solid: !insignificant` is still exactly right. (2) THE HEADLINE IS SLIGHTLY OVERSTATED: 'the wire cannot be crossed at all' is false in the strict sense - a hand-authored 3-leg path with explicit `zs` that CLIMBS onto the wire's 1.417in top, walks across and drops off IS accepted (proved: ok:true, total 6in of a 6in Move: 1 + 2 climb + 2 across (incl. the +1in surcharge) + 0 drop + 1). It is unreachable in practice, though: `surfacesAt` on the wire returns [0] because the part is not standable, so `reachableCells` - the flood fill behind both the AI and the board's move preview - never puts a node on it (proved: 0 reached cells above the floor, and 0 reached cells at y=11 with x>=9 on a 6in budget). And `noClimb` actions can never do it ('Dash cannot climb'). So the correct statement is: the wire cannot be crossed horizontally by anything, cannot be crossed at all by a Dash, and cannot be crossed by any path the shipped path builder can produce. (3) THE AUDIT'S FIRST-CHOICE FIX IS WRONG. It offers `solid: false` in buildEquipmentFeature OR a skip in pathBlockedByTerrain as equivalent. They are not: I simulated `solid:false` and the straight cross does become legal at 5in, but an operative may then FINISH standing in the middle of the razor wire (proved: Reposition to (8,11) accepted, 3in), which breaks killzones.txt:165 'Operatives must finish a move in a location they can be placed'. `solid:false` also removes the part from `index.solid`, and src/teams/wyrmblade/index.ts:402 and src/teams/hernkyn-yaegir/index.ts:305 build their own placement-zone polygon sets from `part.solid !== false`, so their zones would silently open up over razor wire. Take the pathBlockedByTerrain skip only. Two defects the audit missed: obstructingCrossings has NO z filter (an operative on a 3in Vantage gantry directly above the wire is charged the extra inch), and `extra = (obstructing.length > 0 ? 1 : 0)` charges +1in whether one or two wires are crossed (the same open half of W-19, which was fixed via D-077's standingOn skip-set and never got the strict-crossing predicate the audit proposed).

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Reduce W-22 to its residual and reword the audit line; drop the impassability claim.

DO NOT MAKE CHANGE 1. Leave `src/core/terrain.ts` `pathBlockedByTerrain` (line 283) alone, leave `defaultSolid` (terrain.ts:65) alone, leave `src/core/equipment/kit.ts:145 solid: !insignificant` alone. Razor wire is crossed by climbing over it, at the general 2\" minimum climb, plus the Obstructing inch — which is what the engine does today (proved).

CHANGE A — src/core/terrain.ts:308 `obstructingCrossings`. Add the z argument and the "within 1\" of it" clause. The z predicate MUST be the inclusive form `accessibleCrossings` already uses at terrain.ts:243-246, not the plan's exclusive one:
    if (!(p.z0 <= z + 1e-6 && p.z1 >= z - 1e-6)) return false;
At z=0 this charges the ground-level approach; at z = p.z1 (the across-the-top increment of the climb-over) it still charges, preserving today's correct behaviour; at z=3 on a gantry it does not. Then, for the "within 1\" of it" half, the investigator's axis predicate is acceptable — the wire is always `rectPoly` (kit.ts:76-88), so the barrier line is the segment joining the midpoints of the two SHORTEST edges — provided the distance is measured centre-line-to-polygon per D-064 (docs/DECISIONS.md:71) and the new `segmentIntersectionPoint` goes in src/core/geometry.ts without touching `segmentCrossesPoly`. Their argument against the audit's 1\"-inflated polygon is correct and should be kept: `segmentCrossesPoly` returns true for an endpoint inside the polygon (geometry.ts:262), so an inflated rectangle charges an operative that merely starts within 1\" and walks away.

CHANGE B — src/core/movement.ts:224-225. Pass `curZ` into `obstructingCrossings` and make the surcharge per feature: `const extra = (access.length > 0 ? 1 : 0) + obstructing.length;` (universal-equipment.txt:102 reads per feature). Keep it a separate commit as the investigator says; the identical stacking question is open for Accessible (W-19's second half).

CHANGE C — tests/equipment.test.ts:180-190. The existing assertion is vacuous. Rewrite the Razor Wire describe to pin the RAW model, quoting killzones.txt:160 and universal-equipment.txt:102:
  - the straight ground-level cross is REJECTED with 'cannot move through equipment (Exposed+Obstructing)', exactly as a light barricade is (add the light-barricade comparison so nobody re-opens this);
  - the climb-over from (6.8,11) via points [(7.6,11),(8.4,11),(9.2,11)] zs [0,1.4173228346456694,0] is ok:true, total 6, and the across leg carries note '+1\" terrain' — this is the assertion that pins the toll is reachable;
  - a 4\" move at y=12.9 (0.483\" past the wire's end) is charged 5 — FAILS AT HEAD (4);
  - a 4\" move at y=14 (1.583\" clear) is charged 4;
  - a 2\" move at z=3 on a Vantage part added to state.map.features AFTER placement (the onKillzoneFloor constraint rejects the wire otherwise), with ctx.terrainCache cleared, is charged 2 — FAILS AT HEAD (3).

FILE SEPARATELY, DO NOT FOLD INTO W-22: `reachableCells` (src/core/movement.ts:576-631) and `routePath` (648-695) can never produce a climb-over of a non-standable solid part, because `surfacesAt` (terrain.ts:170) only returns standable levels — proved to return [0] on top of razor wire, the light barricade and the heavy barricade alike. So the AI and the board's move preview only ever route AROUND equipment terrain and around every low barricade on every map. Real defect, general, fix belongs in the flood fill (emit a traverse node at part.z1 for a solid non-standable part within the 3\" climb limit), not in terrain.ts.

OWNER DECISION: only one, and it is narrower than the investigator's. Nothing in docs/DECISIONS.md D-001..D-102 mentions razor wire, Obstructing or equipment terrain crossing (grep confirmed). The question to record is how "cross over this terrain feature within 1\" of it" is modelled (axis-line-within-1\" vs inflated polygon), plus the stacking question, decided together with W-19's open half. The investigator's larger question — whether the wire may be crossed horizontally at all — should not be put to the owner as open: killzones.txt:222 vs universal-equipment.txt:102 answers it.

**Why the original plan was rejected.** THE HEADLINE IS REFUTED BY THE CORPUS AND BY A RUN. Two independent failures.

*(Full objection in the git blob above.)*

### Test

All in tests/equipment.test.ts, `describe('Razor Wire')` (currently one test, lines 179-190). Every assertion quotes universal-equipment.txt:102.

Amend the existing test (line 180): add `expect(straight.ok).toBe(true);` immediately before `expect(straight.total).toBe(5);`. THIS IS THE ASSERTION THAT FAILS AT HEAD - proved above, ok:false / reason 'cannot move through equipment (Exposed+Obstructing)'.

New tests, all with the wire placed at (8,11) rot 90 (poly x 7.8031..8.1969, y 9.5827..12.4173) and the 32mm Move-6 test.trooper:
1. THROUGH THE REDUCER: `act(game, a, 'Reposition', { path: { points: [{x:10,y:11}] } }, {x:6,y:11})` returns ok:true; `game.state.operatives[a].pos` is (10,11); `game.state.rejected` is unchanged in length.
2. A DASH MAY CROSS: from (7,11), `validateMove(..., { points:[{x:9,y:11}] }, moveOptionsFor('Dash'))` is ok:true with total 3 (2in + the inch) against the 3in Dash budget. Pins that the fix is NOT a climb (`noClimb` would reject it).
3. WITHIN 1in OF THE END IS CHARGED: from (6,13) to (10,13) - the segment meets the wire's axis 0.583in past its end - total 5, ok:true. FAILS AT HEAD (total 4).
4. MORE THAN 1in CLEAR IS NOT: from (6,14) to (10,14) - 1.583in past the end - total 4.
5. PARALLEL INSIDE THE BAND IS NOT CHARGED: from (8.7,9) to (8.7,13), 0.503in from the wire's long face and never crossing its axis - total 4. This is the assertion that pins the chosen predicate against the inflated-polygon alternative; write it only once the owner has ruled (see ownerDecisionNeeded).
6. A MOVE MAY NOT FINISH ON THE WIRE: `validateMove(..., { points:[{x:8,y:11}] }, ...)` is ok:false with reason 'cannot finish on equipment (Exposed+Obstructing)'. PASSES AT HEAD and must keep passing - it is what makes the pathBlockedByTerrain skip the right fix rather than `solid:false`, and it fails under `solid:false` (proved).
7. NO SURCHARGE ABOVE THE WIRE: add a Vantage part (types ['Vantage'], z0=z1=3, standable) spanning (6,10)-(14,12) to `state.map.features` AFTER placing the wire (the `moreThan2FromAccessible` / `onKillzoneFloor` constraints reject the wire otherwise), clear `ctx.terrainCache`, then a 2in move at z=3 from (7,11) to (9,11) is charged 2, not 3. FAILS AT HEAD (3).
8. (Only if the owner accepts the stacking half of change 3.) Give p2 eq.razorWire too, place a second wire crossing the same increment, assert +2in.

### Risk

Low-to-medium, and entirely confined to games where a player actually selects eq.razorWire - no map data, terrain fixture or docs/ui-review capture moves, because razor wire only ever exists as a `placedFeatures` entry.

- Making the wire passable makes moves near it cheaper, so `reachableCells` grows around a placed wire and AI move evaluation shifts. `pnpm soak` should be re-run; it only matters for bots that took razor wire.
- `pathBlockedByTerrain` is called from validateMove (movement.ts:253), reachableCells (621) and routePath (675). The skip is keyed on a terrain type that exists on exactly one feature in the whole codebase (`grep -rn "'Obstructing'" src/` -> src/core/terrain.ts:65, src/core/equipment/barricades.ts:36, src/core/types.ts:61, src/ui/Board.tsx:91,96), so no other terrain changes behaviour.
- Existing tests that could move: tests/equipment.test.ts:189 keeps asserting total 5 (unchanged - the leg was always charged 5, the move was merely rejected afterwards). tests/wiring.test.ts:152 selects eq.razorWire but only exercises the SelectEquipment intent, never a move. No other test in the tree mentions razor wire or Obstructing.
- The z filter added to `obstructingCrossings` makes it stricter; the only way it could remove a currently-charged inch is the gantry-over-the-wire case, which is the defect.
- The `extra = access + obstructing.length` change is the only part that could over-charge if the axis predicate has an off-by-one on a corner. Keep it a separate commit.
- DO NOT take the `solid:false` route: PROVED that it legalises finishing inside the wire, and `part.solid !== false` is read by src/teams/wyrmblade/index.ts:402 and src/teams/hernkyn-yaegir/index.ts:305 to build placement-zone polygons, so those two teams' zones would silently open up over razor wire.

### OWNER — this cannot land without an answer

Yes - one, and it is the same one the audit flagged. Nothing in docs/DECISIONS.md D-001..D-102 covers razor wire, Obstructing or equipment terrain crossing; the nearest neighbours are D-064 (centre-line movement test) and D-077 (the surface you stand on is not terrain you move through), both of which the recommended predicate is consistent with.

HOW SHOULD "cross over this terrain feature WITHIN 1in OF IT" BE MODELLED?
  (A) RECOMMENDED - the increment crosses the wire's long axis LINE at a point within 1in of the wire polygon. Charges: straight over the model; slipping round an end within 1in. Does not charge: a move that starts or ends within 1in and never gets to the other side; a move running parallel inside the 1in band. Exact, cheap, no polygon offsetting.
  (B) The audit's suggestion - the wire polygon inflated by 1in, tested with `segmentCrossesPoly`. Because that function returns true for an endpoint inside the polygon, it also charges the two cases (A) declines, including an operative that begins its Reposition 0.8in behind the wire and walks directly away.
Whichever is chosen must be written into docs/DECISIONS.md as a new D-entry, and test 5 of the test plan is written to match it.

Second, minor: should crossing TWO razor wires in one increment cost +2in? The rule reads per feature, so yes, but the identical stacking question is still open for Accessible terrain (W-19's second half was never fixed) and the two should be decided together.

### Files

`src/core/terrain.ts`, `src/core/geometry.ts`, `src/core/movement.ts`, `tests/equipment.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`


---

## W-23

*Effort: medium*

### The rule

```
docs/rules-source/universal-equipment.txt:138 - "A portable barricade is Light, Protective and Portable terrain, except the feet which are Insignificant and Exposed. Before the battle, you can set it up wholly within your territory, on the killzone floor and more than 2\" from other equipment terrain features, access points and Accessible terrain."
docs/rules-source/universal-equipment.txt:140 - "Protective: While an operative is in cover from this terrain feature, improve its Save stat by 1 (to a maximum of 2+)."
docs/rules-source/universal-equipment.txt:142 - "Portable: This terrain feature only provides cover while an operative is connected to it and if the shield is intervening (ignore its feet). Operatives connected to the inside of it can perform the following unique action during the battle."
Note the two loads: :142 gates COVER on connection, and :140 gates the SAVE BONUS on "in cover FROM THIS TERRAIN FEATURE" - not on being in cover generally. Both are unimplemented. Note also that neither sentence says "friendly": :142 says "an operative", :140 says "an operative". Only the unique action is scoped, to "Operatives connected to the INSIDE of it".
```

### The original audit entry is wrong about this

Accurate on the headline and the diagnosis; three corrections and two additions. CORRECT AS WRITTEN: the `types: ['Light','Protective','Portable']` assignment is still at src/core/equipment/portableBarricade.ts:36; `grep -rn "'Portable'" src/` still returns exactly two hits (that line and src/core/types.ts:63) plus the Board.tsx colour table; `connectedBarricade` (portableBarricade.ts:54-64) gates only the MOVE WITH BARRICADE action and is never consulted by cover; and the Conceal consequence is real - the target is dropped from `validTargets` entirely. CORRECTION 1: the free-cover window is NARROWER than the prose implies. Cover needs the part within 1in of the target's base (visibility.ts:366) and `connectedBarricade` needs <=0.25in, so the unearned-cover band is a base gap in (0.25in, 1.0in] - 0.75in wide. Beyond 1in the operative correctly gets nothing (measured: y=9.5 in, y=9.0 out). It is still a free cover save and a free Conceal immunity, but it is a 0.75in band, not 'anyone behind it'. CORRECTION 2: THE AUDIT'S PROPOSED SHAPE IS WRONG TWICE OVER. (a) 'Add a CoverOpts predicate' would miss the defect: `coverAndObscured` has 33 call sites and only 13 pass an opts object at all, so an opts-based gate leaves 20 team-module call sites ungated. The gate must be an inline `continue` in the coverParts loop - `coverAndObscured` already has target.pos/base/rot and the part, so it needs nothing from the caller. (b) 'reusing connectedBarricade's geometry' cannot be done by importing it: src/core/visibility.ts -> src/core/equipment/portableBarricade.ts -> src/core/movement.ts -> src/core/visibility.ts is a module cycle. `CONNECTED_INCHES` must move to a leaf module first. CORRECTION 3: 'Narrow the Protective hook to fire only when that same feature appears in cover.coverParts' is the right idea but is not currently possible - equipment modules are registered as `register(reg, player)` with NO GameContext (src/core/context.ts:125 passes ctx to teams but line 126 does not pass it to equipment), and `AttackContext` (src/core/hooks.ts:116-132) carries only a boolean `inCover`. The cover source has to be threaded through TargetCheck -> ShootSequence -> AttackContext. ADDITION 1 (missed by the audit): the Protective hook has NO friendly check on the defender - `ev.state.placedFeatures.find(f => ... f.owner === b.player)` picks WHICH barricade to look at, then measures against `ev.ctx.defender` whoever that is, so p1's barricade hands +1 Save to a p2 defender standing near it (proved). ADDITION 2 (missed by the audit): the hook fires when there is NO cover from the shield at all - I got mods.save === 1 with `coverAndObscured` returning inCover:false and coverParts:[], the operative unconnected, and the shield 1.34in away and off to one side. And the 1.5in test is base-centre-to-polygon-CENTROID, so it is base-size dependent (0.87in of edge slack on a 32mm base, 0.52in on a 50mm) and inconsistent with `connectedBarricade`'s base-edge-to-polygon <=0.25in. FINALLY, the audit's test plan asserts 'an ENEMY operative connected to it gets nothing' - that is NOT what the rule says ('while AN OPERATIVE is connected to it', not 'a friendly operative') and it is an owner decision, not a defect.

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Take the plan essentially as written — changes 1 to 4 are correct in shape and the inline `continue` in `coverAndObscured`'s coverParts loop (not a CoverOpts predicate) is the right call, since 34 call sites exist and most pass no opts. Four amendments:

(a) Add to change 3a/3b: on the Blast branch at src/core/sequences/shoot.ts:987-989, set `seq.coverFeatureIds = []` (or resolve the question deliberately). Otherwise a Blast secondary inherits the primary's shield and collects the Protective +1 for cover it never had.

(b) Write the D-entry with THREE questions, not two: (i) is "an operative is connected to it" the TARGET or ANY operative — recommend the target, and note the plan cannot express "any operative" inside `coverAndObscured` at all; (ii) friendly-only or RAW-neutral — recommend RAW-neutral, as the investigator does, since universal-equipment.txt:140 and :142 both say "an operative" and only MOVE WITH BARRICADE is scoped ("Operatives connected to the INSIDE of it"); (iii) `CONNECTED_INCHES = 0.25` as the model of "connected to", measured base-edge to shield polygon, noting the deleted 1.5\" centre-to-centroid spelling was inconsistent and base-size dependent. Nothing in D-001..D-102 covers razor wire, Obstructing, Portable, Protective or the portable barricade — grep confirmed — so this is a genuinely new entry.

(c) Replace the "cf. D-096" comment in change 4 with a reference to src/core/context.ts:124-128 (rebuildHooks registers each player's equipment separately) or to the new D-entry.

(d) Test plan: keep tests 1-7 as written, and add the end-to-end shape I proved — a real `PerformAction Shoot` through `reduce` where the only cover part is a Heavy block and the defender is unconnected, asserting the observed `mods.save` is 0. That is the assertion that fails at HEAD in the live sequence (measured 1), and it is stronger than test 4(ii)'s hand-built AttackContext because it cannot be dismissed as state the reducer would never produce. Repro at /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vfy-w23b.test.ts.

**Why the original plan was rejected.** CONFIRMED LIVE, and I strengthened one of the investigator's claims by proving it through the real reducer rather than a hand-built AttackContext. Reproductions: /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vfy-w23.test.ts and vfy-w23b.test.ts.

*(Full objection in the git blob above.)*

### Test

All in tests/equipment.test.ts, `describe('Portable Barricade')` (currently two tests, lines 276-311). Every assertion quotes universal-equipment.txt:140/142. Barricade placed at (10,11) rot 0 (shield poly x 9.6063..10.3937, y 10.8031..11.1969); 32mm test.trooper, r 0.63in.

1. NOT CONNECTED, NO COVER. Target p1-0 at (10,9.5) (base gap 0.673in), shooter p2-0 at (10,18). Assert `connectedBarricade(ctx, state, target)` is undefined AND `coverAndObscured(terrain(ctx,state), body(ctx,shooter), body(ctx,target)).inCover` is false with `coverParts` empty. FAILS AT HEAD - measured inCover:true, coverParts ['equip.p1.eq.portableBarricade.0.body'].
2. NOT CONNECTED, CONCEAL IS TARGETABLE. Same geometry, target at (10,9.2) with `order='conceal'`. Assert `checkTarget(ctx, state, shooter, target, profile, rules).valid` is true and `validTargets(ctx, state, shooter, 'lasgun').map(x => x.target.id)` contains 'p1-0'. FAILS AT HEAD - valid:false, reason 'target has a Conceal order and is in cover', and validTargets returns only ['p1-1','p1-2'].
3. CONNECTED, COVER. Target at (10,10.1) (base gap 0.073in <= 0.25in). Assert connected, `inCover` true, and `coverParts.map(p => p.id)` is exactly ['equip.p1.eq.portableBarricade.0.body'] - the same assertion pins '(ignore its feet)', since neither `.foot0` nor `.foot1` may appear. PASSES AT HEAD; keep as the regression pin that the gate did not over-tighten.
4. THE SAVE BONUS IS TIED TO THE SHIELD'S OWN COVER. Two halves in one test:
   (i) target connected at (10,10.1), shooter at (10,18), emit `onDefenceDice` with an AttackContext carrying `inCover: true` and `coverFeatureIds: ['equip.p1.eq.portableBarricade.0']` -> `ev.mods.save` is 1.
   (ii) target at (10,9.6) with the barricade re-placed at (11.2,10.2) and a Heavy block supplying the cover instead; emit with `inCover: true` and `coverFeatureIds: ['blk']` -> `ev.mods.save` is 0. FAILS AT HEAD - measured 1.
   NOTE: the existing test at tests/equipment.test.ts:291-310 builds its AttackContext by hand with `inCover: true` and no cover ids; after change 3 it must gain `coverFeatureIds: ['equip.p1.eq.portableBarricade.0']` or it will start asserting 0. That is the one existing test this work moves.
5. REGISTERED TWICE, APPLIED ONCE. Give BOTH p1 and p2 eq.portableBarricade, place only p1's, put a connected p1 operative behind it, emit `onDefenceDice` with that feature's id in `coverFeatureIds`. Assert `ev.mods.save` is 1, not 2. This is the D-096 / W-24 trap (the module registers per player) and there is no test for it today.
6. THE OWNERSHIP CASE, written to whatever the owner rules. Target p2-0 connected to p1's barricade at (10,10.55), shooter p1-0 at (10,18): either assert `inCover` true and `mods.save` 1 (RAW), or `inCover` false and 0 (house rule). Do not write it before the decision.
7. END-TO-END SANITY (optional, tests/rules-review.test.ts): drive a real Shoot with `battle(...)/drain()` at a target 0.5in behind the shield and assert the defence pool gets no cover save; then with the target touching the shield assert it does and the save used is 3+ rather than 4+.

### Risk

Low on the rules side, medium on the mechanical side - the change is wide but shallow.

- `coverFeatureIds` on `AttackContext` MUST be optional (`?:`). There are ~40 hand-built AttackContexts across src/teams/** and 4 more in src/core/sequences/{shoot,fight}.ts; making it required is a 45-file edit for nothing. `TargetCheck.coverFeatureIds` and `ShootSequence.coverFeatureIds` can and should be required, which is a handful of literals - `pnpm typecheck` finds every one.
- The `CONNECTED_INCHES` move is mandatory, not cosmetic: importing it from portableBarricade.ts into visibility.ts closes a cycle visibility -> equipment/portableBarricade -> movement -> visibility, and a top-level `const` read across an ESM cycle is a TDZ hazard, not a warning.
- Change 2 makes cover STRICTER, so any AI evaluation that leaned on phantom barricade cover shifts; only games where a player took eq.portableBarricade are affected. `src/ai/eval.ts:321,333` call `coverAndObscured` directly and pick the change up for free.
- The barricade is Light+Protective+Portable and never Heavy, so it can never trigger `mustChoose`; the `seq.coverFeatureIds = []` line in decisions.ts:44 is defensive tidiness rather than a live path.
- tests/teams/wrecka-krew.test.ts:1010 ('EXTRA ARMOUR isn't cumulative with the Protective rule of a Portable Barricade') pushes a `parts: []` barricade and pre-seeds `mods.save = 1` by hand; the portableBarricade hook is not registered in that game (p1 never selects eq.portableBarricade), so it does not move. Confirm that by running it - if the hook ever did run there, `shieldPoly` would throw on `feature.parts[0]!.poly`.
- Only one existing test actually moves: tests/equipment.test.ts:291-310, which must supply `coverFeatureIds`.

### OWNER — this cannot land without an answer

Yes - one substantive, one to record. Nothing in docs/DECISIONS.md D-001..D-102 mentions the portable barricade, Protective or Portable; the closest precedent is D-096 ('the module registers once per player', which is why change 4 keeps the `f.owner === b.player` clause).

DECISION A (blocks test 6, and blocks the shape of changes 2 and 4). DOES AN OPERATIVE GET COVER, AND THE PROTECTIVE +1 SAVE, FROM AN ENEMY'S PORTABLE BARRICADE IT IS CONNECTED TO? The text is neutral: :142 says 'while AN OPERATIVE is connected to it' and :140 says 'While AN OPERATIVE is in cover from this terrain feature' - neither says 'friendly', and only the unique action is scoped ('Operatives connected to the INSIDE of it'). A portable barricade is terrain in the killzone once set up, and all other equipment terrain (light barricades, the heavy barricade) gives cover to whoever stands behind it regardless of who paid for it. RECOMMENDED: RAW - anyone connected to the shield with it intervening gets the cover and the +1 Save. That is also what the plan above implements with no extra plumbing. The audit's test plan asserts the opposite ('an ENEMY operative connected to it gets nothing') without a rule citation; if the owner prefers that, changes 2 and 4 both need an ownership filter, and change 2's would have to move out of `coverAndObscured` (which has no notion of players) into `checkTarget`.

DECISION B (record only). `CONNECTED_INCHES = 0.25` is an undocumented judgement - 'connected to' is modelled as the base being within a quarter inch of the shield polygon. It has been harmless while it only gated one action; once cover depends on it, it decides whether a shot lands. Promote it to a D-entry, and note in the same entry that the old 1.5in-centre-to-centroid test in the Protective hook was a second, inconsistent and base-size-dependent spelling of the same idea, now deleted.

### Files

`src/core/visibility.ts`, `src/core/terrain.ts`, `src/core/equipment/portableBarricade.ts`, `src/core/hooks.ts`, `src/core/sequences/shoot.ts`, `src/core/sequences/types.ts`, `src/core/decisions.ts`, `tests/equipment.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`


---

## W-28

*Effort: medium*

### The rule

```
docs/rules-source/killzones.txt:516-523 (KILLZONE: TOMB WORLD section, which starts at :455):
:516 "BREACH2AP"
:517 "Open a closed breach point thats access point is within the operative's control range."
:519 "An operative that has the word(s) 'breach marker', 'grenadier' or 'mine' on its datacard, or has a weapon with the Piercing 2 or Piercing Crits 2 weapon rule (excluding weapons that have the Blast or Torrent weapon rule) can perform this action for 1 less AP (to a minimum of 1AP)"
:521 "Roll one D6 separately for each operative that's on the other side of the access point and has that access point within its control range: on a 4+, subtract 1 from that operative's APL stat until the end of its next activation and inflict damage on it equal to the dice result halved (rounding up)."
:523 "An operative cannot perform this action while within control range of an enemy operative, or if that breach point is open. It cannot perform this action for less than 2AP during an activation/counteraction in which it performed the Charge or Shoot action (or vice versa)."

Identical text is reprinted in docs/rules-source/tomb-world.txt:1240-1247.

Operate Hatch, which shares the defective measurement, is docs/rules-source/killzones.txt:495-500:
:496 "Open or close a hatchway thats access point is within the operative's control range."
:500 "An operative cannot perform this action while within control range of an enemy operative, or if that hatchway is open and its access point is within an enemy operative's control range."

Control range itself (CLAUDE.md invariant, core-rules): visible to and within 1".
```

### The original audit entry is wrong about this

Both headline claims in the title are now FALSE at HEAD; the body's third claim is TRUE; and three defects the audit never mentions are live.

(1) "Breach performs no control-range check" — FALSE. `src/core/actions.ts:588-592` has the check and it fires: a breacher 5.9" from the access point is rejected with 'the breach point is not within control range'; the same operative at 1.09" succeeds and the part flips to ['Accessible','Insignificant','Exposed'].
(2) "its concussion roll hits operatives on the breacher's own side of the wall" — FALSE. `acrossFrom()` (actions.ts:637-643) is applied at actions.ts:611-613: with a friendly 0.20" from the access point on the breacher's side and an enemy 0.00" from it on the far side, exactly ONE roll is made, against the enemy; the friendly stays at 10 wounds and [] aplMods.
(3) "the 2AP clause exists only as a comment" — TRUE, and now the ONLY surviving line of the entry. The clause appears exactly once inside the Breach action and it is a `//` comment (actions.ts:594-595); `actionsThisActivation` is never read there.

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Keep changes 1 and 2 in shape, with these edits.

1. Measurement: switch all sites to `baseGapToPoly(pos, base, rot, part.poly)` as proposed (src/core/geometry.ts:303 — it exists), but add src/teams/battleclade/index.ts:1503,1509 and src/teams/canoptek-circle/index.ts:1854,1865 to the list, or extract one exported core selector — e.g. `accessPointGap(index, ctx, op, part): number` in src/core/terrain.ts — and have all six sites call it. State the risk honestly in both directions and grep the maps/ops/teams suites for fixtures placed PERPENDICULAR to an access point at 1.0-1.4", not only for ones just outside.

2. :519 discount: keep `apFor`, but consult the hook FIRST and apply the printed floor after, or give apFor its own clamp so the :519 minimum survives: `const printed = action.apFor ? action.apFor(ctx, state, op) : action.ap; const ev = ctx.hooks.emit('onActionCost', …, { ap: printed }); return Math.max(0, ev.ap);` still yields 0 for Phobos. Either clamp Breach specifically (`Math.max(1, …)` when the discount fired) or record in DECISIONS that team discounts stack below the printed floor. Widen the word search to unanchored substrings for the plural forms — `/breach marker|grenadier|mine/i` matches kommandos.breacha-boy — and put the exact surface AND the anchoring choice in the owner question, with the corrected count (17 cards / 16 teams for the word half, 35 more datacards for the Piercing half). Move the Blast/Torrent exclusion up to the weapon level to match the printed text (one card changes: canoptek-circle.geomancer).

3. :523 forward: DO NOT reject. Make the discount conditional inside the cost, i.e. in `breachDiscount()` add `if (did(op, 'Charge') || did(op, 'Shoot')) return false;` (`did` is src/core/actions.ts:78; `restrictionKey = def.treatedAs ?? def.id` at reducer.ts:369 so 'Charge'/'Shoot' are recorded verbatim). Breach then simply costs 2AP after a Shoot, which is what :523 says, and the AP gate at reducer.ts:382 handles affordability by itself. Drop the `state.opState['actionAp']` plumbing entirely — with the cost decision moved into `actionCost`, `check` never needs the number, and the stale-key bug at reducer.ts:375/:388 disappears.

4. :523 reverse ("or vice versa"): keep the `breachDiscounted` endOfActivation effect blocking Charge and Shoot — that half is right, and phases.ts:257 / reducer.ts:424 do expire it as claimed. Note that the counteraction half is already unreachable because reducer.ts:375 gates on `def.ap !== 1`, which the report gets right.

**Why the original plan was rejected.** The item IS still live and the report's re-framing of the audit text (claims 1 and 2 FALSE, claim 3 TRUE, D-085 already covers 1 and 2) is correct — I confirmed the control-range check at /home/user/kill-team-mobile/src/core/actions.ts:588-592 and the acrossFrom() far-side filter at :611-618 by code read, and the report's own reproductions hold. But the PLAN is wrong in six places, five of which I proved by running code (all runs from /home/user/kill-team-mobile at HEAD a775289, config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/adv/vitest.config.ts).

*(Full objection in the git blob above.)*

### Test

All in tests/rules-review.test.ts, each quoting its rule line.

1. killzones.txt:517 — on the real tomb-world-2 map, breach point `tomb-world-2.B2-2.access`:
   - an operative at (6.0, 13.82) dispatching `PerformAction Breach {partId}` is rejected, reason contains 'not within control range', and `state.terrainState[AP].state !== 'open'`;
   - the same at (11.0, 13.82) is accepted and the part's types become ['Accessible','Insignificant','Exposed'];
   - NEW REGRESSION: an operative at (11.0, 15.72) — 0.533" from the access-point POLYGON but 1.078" from its bbox centre — is now ACCEPTED. Assert `baseGapToPoly(pos, base, 0, part.poly) < 1` in the same test so the fixture states why.
2. killzones.txt:500 — the same false negative for Operate Hatch on `tomb-world-2.A4-1.access`: an operative level with the end of the opening can now open it, and an ENEMY level with the end of an open one now denies it.
3. killzones.txt:521 — breacher at (11.0,13.82), friendly at (11.0,13.0) (own side), enemy at (12.8,13.82) (far side), enemy at (12.8,15.72) (far side, beside the opening's north end), ScriptedRng [6,6,6,6]: assert exactly TWO breach rolls, both naming the two far-side enemies; the friendly keeps 10 wounds and [] aplMods; each enemy loses ceil(6/2)=3 wounds and gains aplMods [-1] with an effect whose expiry.kind is 'endOfNextActivation'. (Today this test yields ONE roll.)
4. killzones.txt:519 — `actionCost(ctx, state, op, getAction('Breach')!)` is 1 for `phobos-strike-team.incursor-minelayer` (ability 'Haywire Mine' — the word 'mine'), 1 for `hearthkyn-salvager.grenadier`, 1 for an operative whose weapon profile carries Piercing 2 without Blast/Torrent, and 2 for a plain trooper. Assert it is still 2 for a datacard whose only Piercing-2 weapon also has Blast.
5. killzones.txt:523 forward — the PHOBOS w28b scenario: infiltrator warrior Shoots, then `PerformAction Breach` is REJECTED with 'less than 2AP', and `state.terrainState[AP]?.state !== 'open'`. Then the same operative with Vanguard already spent (so the cost is 2) Breaches successfully after a Shoot.
6. killzones.txt:523 reverse — the same operative Breaches first for 1AP (accepted), then `Shoot` is rejected and `Charge` is rejected with 'already performed Breach for less than 2AP this activation'; after EndActivation the effect is gone from `state.effects`.
7. Contract: assert `state.rejected` grows by one on each rejection (architecture rule 1 — illegal intents are rejected, never thrown).

### Risk

Change 1 WIDENS who may Breach/Operate Hatch (26% more of the true control-range area is now accepted) and widens the concussion blast to victims beside the ends of an opening. Grep the maps/ops suites for Operate Hatch and Breach fixtures placed deliberately just outside 1" of a bbox centre — those positions may now be legal and any test asserting a rejection there will flip. `src/ai/legal.ts:195-200` enumerates a Breach/Operate Hatch candidate for EVERY access-point part and filters with `def.check`, so the AI will simply gain candidates; no rejected intents.

Change 2 makes Breach 1AP for 18 datacards across 15 teams (measured: 11 match 'grenadier', 7 match 'mine', plus every Piercing-2 carrier). On Tomb World that changes AP budgeting in the AI search and in `actionAvailability`, so re-run `pnpm soak`. The word search is deliberately broad because :519 says "has the word(s) … on its datacard"; I checked the 18 hits by hand and all are legitimate (e.g. brood-brother.sapper's ability is literally named 'Grenadier'; ratlings.bullgryn carries a 'Grenadier gauntlet'). Widening or narrowing the searched fields changes the answer, which is why it wants a DECISIONS row.

Change 3 adds `apFor` to the ActionDef contract — a public shape every action module and `tests/` may construct; `tsc --noEmit` strict will find any that break. `state.opState['actionAp']` must be deleted on BOTH the success and the revert path in reducer.ts (the revert at reducer.ts:390-405 restores `before`, which never had the key, so that path is already safe — but the success path must clean up or a later action in the same activation will read a stale cost).

No replay risk: none of the three changes touches the RNG cursor or the roll journal except by adding/removing concussion rolls in fixtures that already script their dice, so seeded fixtures that perform a Breach WILL re-baseline.

### OWNER — this cannot land without an answer

One decision, plus one thing to record.

DECISION: which fields of a datacard count as "the datacard" for killzones.txt:519's word search. I propose name + keywords + weapon names + ability names and text + unique-action names and text. Including or excluding weapon PROFILE names, fluff, or the team name changes which operatives get Breach at 1AP. The owner should confirm the surface (and may want to see the 18-card list) before it becomes the number the AI budgets against.

RECORD, not decide: D-085 in docs/DECISIONS.md already documents the control-range check and the far-side concussion filter as owner-blessed. This change does not reverse D-085 — it corrects the MEASUREMENT inside it (polygon rather than bbox centre) and adds the two clauses D-085 never mentioned. Amend D-085 or add a successor row rather than opening the question again.

NOT an owner question: whether Guard/Close Quarters gating applies. Breach is a Tomb World rule (killzones.txt:455 heading, :502 section), not a Close Quarters one, and it is gated on the data (`opensAs === 'breachWall'`), so D-002 is not in play.

### Files

`src/core/actions.ts`, `src/core/reducer.ts`, `src/core/geometry.ts (import only — baseGapToPoly already exists at line 303)`, `tests/rules-review.test.ts`, `docs/RULES-COVERAGE.md`, `docs/DECISIONS.md`


---

## W-29

*Effort: large*

### The rule

```
docs/rules-source/killzones.txt:374-383 —
374: "Cityfight"
375: "Killzone: Volkus has the following additional rules."
377: "Condensed Stronghold"
378: "Whenever an operative is shooting with a weapon that has the Blast, Torrent and/or x\" Devastating (i.e. Devastating with a distance requirement) weapon rule, it also has the Lethal 5+ weapon rule if the target is wholly within a stronghold terrain feature and on the killzone floor or a fire step."
380: "The Condensed Stronghold rule always relates to the target's location, so if the primary target is wholly within a stronghold, but the secondary target isn't, then this rule doesn't apply to that secondary target."
382: "Garrisoned Stronghold"
383: "When an operative wholly within a stronghold terrain feature is retaliating against an operative that isn't, the defender resolves first (this takes precedence over the normal fight resolution order)."

Supporting: killzones.txt:249 "The fire steps are Vantage, Insignificant and Exposed terrain." (key C — not extracted, see data/terrain/volkus.json strongholdA notes).
```

### The original audit entry is wrong about this

Substantially accurate; four drifts. (1) `grep -rl volkus src/` now returns FOUR files, not two: src/core/visibility.ts, src/core/types.ts, src/ui/App.tsx, src/ui/MapBrowser.tsx. Still no killzone module. (2) "ten team modules already do seq.turn='defender'" undercounts: 18 sites across 17 team modules (src/teams/{wyrmblade:635, exaction-squad:409, fellgor-ravager:679, farstalker-kinband:1308, elucidian-starstrider:754, nemesis-claw:712, ratlings:660, blades-of-khaine:1204, celestian-insidiants:469, mandrakes:1286, corsair-voidscarred:575+592, raveners:1114+1137, sanctifiers:725, pathfinders:587, legionary:627, deathwatch:454}). The hook they use is `onCollectAttackDice`, which fires inside `rollSide`; `seq.turn` is read only at the `resolve` step, so flipping it there works. (3) The suggested test COORDINATES ARE WRONG: it says "a defender at (6.4,5.0) wholly inside Stronghold B with the attacker at (7.1,5.0) outside". On volkus-1 Stronghold B occupies x 3..11, y 3..11, so (7.1,5.0) is INSIDE it too — both operatives would be within the stronghold and the rule would (correctly) not fire. (4) The audit says W-29 is "gated on W-04". W-04 is marked FIXED and DID land the parapet banding + key F ramparts, but it did NOT land key C fire steps — data/terrain/volkus.json's strongholdA notes still read "Rules parts the map cards do not draw... the fire steps (Vantage + Insignificant + Exposed)", and `grep -ro fireStep data/` finds nothing. So the "…or a fire step" half of Condensed Stronghold is still unimplementable; only "on the killzone floor" can be enforced. Everything else in the entry checks out: startFight hard-codes turn:'attacker' (fight.ts:77), all six Volkus maps ship closeQuarters:false, and `grep -rni 'garrison|condensed stronghold|cityfight'` over src/ and tests/ returns nothing.

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Keep the plan; fix the test plan and the risk note.

Test coordinates: replace test 4's straddling defender with a defender that overlaps the wall LINE at a legal spot, or delete it and instead assert the negative through the feature the engine can express — e.g. a defender wholly inside but on `volkus-1.M.p0` at z=1 (inside the hull, not on the killzone floor). Replace test 5's (15.5,17.0) with (11.8,17.0) z=0 (measured terrain-legal and wholly within Stronghold A). Add a test that an operative on the beamRubble at z=1 inside Stronghold A gets NO Lethal, quoting "and on the killzone floor or a fire step" (killzones.txt:378).

Risk: rewrite risk (c) as "seventeen team test files run seeded volkus-1 battles, thirteen through a `for (const mapId of ['volkus-1','gallowdark-1'])` mirror-soak loop whose assertions are behavioural log matches; a drifted replay makes them vacuous rather than red, so re-run the whole set. Measured across nine of those seeded battles the Condensed and Garrisoned triggers fired zero times, so a deliberate re-seed is probably NOT needed — confirm rather than assume."

Geometry decision: state it as "the convex hull of the feature's part polygons; measured 48.00/48.00/48.00/48.25/48.00/49.27 sq in for Stronghold A and 63.74/64.00x5 for Stronghold B against nominal 8x6 and 8x8, i.e. exact on ten of twelve instances and up to 1.27 sq in generous on volkus-6.A", and note that the hull encloses any other feature standing inside the ring.

**Why the original plan was rejected.** LIVE — confirmed independently. `grep -rniE "cityfight|garrison|condensed stronghold|door fight" src/ tests/ docs/RULES-COVERAGE.md` returns ZERO hits; `startFight` hard-codes `turn: 'attacker'` (src/core/sequences/fight.ts:77); all six volkus maps ship `closeQuarters: false`; DECISIONS.md D-001..D-102 has nothing on any of it. Their correction of the audit's undercount (18 `seq.turn = 'defender'` sites in 17 team modules) is exactly right, as is their catch that the audit's suggested attacker coord (7.1,5.0) is INSIDE Stronghold B (measured hull 3.00..11.00 x 3.00..11.00).

*(Full objection in the git blob above.)*

### Test

New tests/killzones/volkus.test.ts, driving the REAL volkus-1 map through the reducer (the pattern in tests/rules-review.test.ts:1088 + tests/teams/harness.ts `mapById`). Ten assertions:

Garrisoned Stronghold, quoting killzones.txt:383 verbatim —
1. attacker p1 at (8.39,18.835) [outside Stronghold A, base touching volkus-1.A.p10], defender p2 at (9.9,18.835) [wholly inside, z=0]: after `PerformAction Fight`, `(state.sequence as FightSequence).turn === 'defender'`. (Precondition assertions in the same test: `inControlRange` is true, and `whollyWithinFeature` says defender-yes / attacker-no.)
2. NEGATIVE — both outside: attacker (8.39,18.835), defender (7.0,18.835) → turn === 'attacker'.
3. NEGATIVE — both inside: attacker (10.5,17.0), defender (11.8,17.0) → turn === 'attacker' (the rule needs the attacker NOT to be within a stronghold).
4. NEGATIVE — defender straddling the doorway so it is not WHOLLY within (centre (9.2,18.835)) → turn === 'attacker'.

Condensed Stronghold, quoting killzones.txt:378 and :380 verbatim —
5. `Blast 2"` weapon, target at (15.5,17.0) z=0 wholly inside Stronghold A → `effectiveRules(...)` contains `{id:'Lethal', x:5}`.
6. same weapon, target at (19.0,17.0) outside → no Lethal.
7. "on the killzone floor": target at (12.0,17.0) z=3, standing on volkus-1.A.p11 (the Ceiling/Vantage level, wholly inside the footprint horizontally) → no Lethal.
8. killzones.txt:380 — a real two-target Blast resolution with the primary inside and the secondary outside: assert the two `effectiveRules` reads differ (Lethal present for the primary, absent for the secondary).
9. no-downgrade: a profile printing `Lethal 4+, Blast 2"` against an inside target keeps exactly one Lethal, x === 4.
10. registered once, not per player: `ctx.hooks.bindings().filter(b => b.id.startsWith('volkus.')).length === 2` on a volkus map and `=== 0` on gallowdark-1 — this is the assertion that catches the W-24 double-registration trap, and it must fail if someone moves the register call inside rebuildHooks' player loop.

Also extend tests/rules-review.test.ts or a terrain test with a pure-geometry assertion for the new selector: for all six volkus maps, `featureFootprint` of each stronghold has area 48±1.5 (A) / 64±0.5 (B) sq in, and a base at the feature's centroid is `whollyWithinFeature` while a base 1" outside its bbox is not.

### Risk

MEDIUM. (a) Double registration is the live trap — see test 10. (b) The convex hull is an approximation: exact for the twelve stronghold instances (measured), wrong for L-shaped features, so `whollyWithinFeature` must never be called with `volkus.largeRuin`. (c) Adding Lethal 5+ to Blast/Torrent on Volkus re-grades dice: any seeded fixture that fires such a weapon at a floor-level target inside a stronghold on volkus-1 replays differently. The volkus-1 users are tests/teams/{goremonger:967, hierotek-circle:166, raveners:360, wyrmblade:1164}.test.ts plus tests/teams/soak.test.ts (which picks the first volkus map). Expect the same kind of deliberate re-seeding D-102 recorded for the Fellgor volkus-1 soak; re-seed rather than exempt. (d) tests/fixtures.ts `testMap()` has `killzone: 'volkus'`, so the module will be registered in every synthetic fixture in the suite. That is harmless — those maps have no `volkus.stronghold*` features so both handlers return early — but it must be verified, not assumed, and it is the reason the handlers must test the FEATURE KIND rather than `state.map.killzone`. (e) `effectiveRules` is hot; the footprint hulls must be cached on the TerrainIndex (which is itself cached by `terrain(ctx,state)` keyed on map identity + terrainState), not recomputed per emit.

### OWNER — this cannot land without an answer

FOUR, and none is already covered — docs/DECISIONS.md D-001..D-102 contains nothing on Cityfight, Garrisoned Stronghold, Condensed Stronghold or a killzone-module registry (D-002 is only about Close Quarters/`closeQuarters`, D-071 about the control-range door exemption, D-101 about the parapet). (1) ARCHITECTURE: introducing `src/core/killzones/` and a KillzoneModule registry is a new subsystem and a new line in CLAUDE.md's Layout; the audit flags this and it is worth agreeing before writing it. (2) GEOMETRY: what "wholly within a stronghold terrain feature" means on machine-extracted data. Proposal: the convex hull of the feature's part polygons, which measures as exactly the 8x6 / 8x8 wall ring on all twelve stronghold instances. Needs the same owner sign-off D-101's 1" parapet got. (3) READING: does an operative on a stronghold's Vantage LEVEL count as "wholly within" for Garrisoned Stronghold? Condensed Stronghold explicitly adds "and on the killzone floor or a fire step" and Garrisoned Stronghold does not, which reads as deliberate — so I would say yes, the roof counts, but it is an interpretation, not a quote. (4) SCOPE: "or a fire step" cannot be implemented. Key C fire steps are still not in the extracted geometry (data/terrain/volkus.json's own notes list them as not drawn, and W-04 landed only key F ramparts). Either the owner accepts a degraded "on the killzone floor" reading, recorded in DECISIONS + RULES-COVERAGE, or key C is extracted first.

### Files

`src/core/terrain.ts`, `src/core/killzones/index.ts`, `src/core/killzones/volkus.ts`, `src/core/context.ts`, `src/core/weaponRules.ts`, `tests/killzones/volkus.test.ts`, `docs/RULES-COVERAGE.md`, `docs/DECISIONS.md`, `CLAUDE.md`


---

## W-32

*Effort: large*

### The rule

```
docs/rules-source/killzones.txt:573-606 (KILLZONE: BHETA-DECIMA):
:576 "Gantry"
:577 "Gantry floors are Accessible and Vantage terrain."
:578 "Gantry pillars are Heavy terrain."
:579 "Gantry terrain features come in three sizes: long, medium and short. When they are connected (i.e. their gantry floors are touching each other), they are treated as the same terrain."
:582 "The roof is Accessible and Vantage terrain."
:583 "The inner-ledge of the roof is Exposed and Insignificant terrain. In other words, ignore the slight difference in height between the outer and inner area of the roof."
:584 "The battlements on the roof are Light terrain."
:585 "All other parts of it are Heavy terrain."
:590 "Restricted Movement"
:591 "No part of an operative's base can be touching a hazardous area."
:593 "Restricted Targeting"
:594 "When selecting a valid target for an operative on the killzone floor, an intended target on the killzone floor is not a valid target if 4\" of hazardous area is between them."
:596 "When selecting a valid target for an operative on Vantage terrain, an intended target on the killzone floor is not a valid target if the footprint of a gantry is between them. The same is also true in reverse (an operative on the killzone floor to an intended target on Vantage terrain). However, in both cases, ignore the footprint of gantry terrain features the operative or the intended target is on or in."
:598 "In both cases, use targeting lines to determine if a hazardous area or the footprint of a gantry is between them."
:604 "Restricted targeting only matters if one or more of the operatives in question are on the killzone floor; if they are both on Vantage terrain, it has no effect."
:606 "A gantry's footprint is the gantry itself, plus the area underneath it."
:613 "Equipment can be set up on Vantage terrain and within 2\" of Accessible terrain (this takes precedence over the usual restrictions)."
```

### The original audit entry is wrong about this

The arithmetic is EXACTLY right and I re-counted it myself: every Bheta-Decima map has exactly ONE Heavy part, `bheta-decima-N.D.p0`, the condenser body. Zero parts have role 'pillar'. All eight gantry features per map are a single zero-thickness deck part at z0=z1=3.0 typed ['Accessible','Vantage','Light'].

The engine half is also exactly right: `checkTarget` (src/core/sequences/shoot.ts:130-231) applies Range, the friendly-control-range block, `isVisible`, cover/obscured, Vantage Accurate and the Conceal denial, and returns. Neither shoot.ts nor visibility.ts contains the string 'hazard', 'gantry' or 'footprint'.

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Engine: take route A (the registry the comment at src/core/context.ts:119 already promises — W-29/W-30/W-31 all need it), but the `onValidTarget` event must gain `secondary?: boolean` and `pointBlank?: boolean`, passed through from `checkTarget`'s `opts`, before any killzone handler can implement this rule. Then the handler returns early on `ev.secondary` — core-rules.txt:818 "they are all valid targets". Add a test asserting a Blast 2\" primary across 13\" of ocean is denied while its secondary beside the primary is still resolved.

Before the Light-vs-pillars question can be answered at all, fix or explicitly scope the `sameHeight` branch at src/core/visibility.ts:275-279: a part whose [z0,z1] lies entirely above `max(a.z, b.z) + height` cannot be crossed by a base-to-base line and must not be intervening. Otherwise every cover measurement on Bheta is meaningless. File it as its own item rather than folding it in silently.

Add `volkus.largeRuin` to the green_edge scope: implementing the producer fixes killzones.txt:584 on Bheta AND the large-ruin ramparts on Volkus, so the extractor change and the QA-table update in docs/MAPS.md cover both killzones.

Add the group-vs-feature ignore scope (killzones.txt:579 vs the :610 example) and the cumulative-vs-contiguous reading of "4\" of hazardous area" as owner questions 4 and 5, alongside the ANY/EVERY question the report already raises. Gate the gantry branch on `isOnVantage(index, body)` (src/core/visibility.ts:437), not merely on "not on the floor".

**Why the original plan was rejected.** Still live, and the report's data audit is accurate — I re-counted through `buildTerrainIndex` independently and got the same numbers (bheta-decima-1..5: 11 parts, bheta-decima-6: 10; exactly one Heavy part per map, `bheta-decima-N.D.p0`; roles floor×9 / wall×1 / ledge×1, no pillar, no rampart). `green_edge` appears 0 times in /home/user/kill-team-mobile/tools/maps/extract_cards.py and the dispatch at :795-801 really does handle only 'green' and 'green_inner'. Neither src/core/sequences/shoot.ts nor src/core/visibility.ts contains 'hazard', 'gantry' or 'footprint'. `rebuildHooks` (src/core/context.ts:119-133) really does promise "then killzone rules" and register none. Quote line numbers :573-613 all verified. But the plan has one rule-level defect that would ship a wrong rule, one claim that rests on an engine bug the report mistook for a feature, and several scope errors.

*(Full objection in the git blob above.)*

### Test

tests/rules-review.test.ts, all on the real bheta-decima-1 map, each quoting its rule line.

1. killzones.txt:594 — shooter (9.5,20.5) z=0 vs target (9.5,2.0) z=0, 13.47" of ocean between them: `checkTarget(...).valid` is FALSE and `reason` names hazardous area. Assert in the same test that neither base touches hazardous (`baseTouchesHazardous` false for both), so the test is about targeting and not about Restricted Movement.
2. killzones.txt:594, the negative — shooter (7.5,13.5) z=0 vs target (7.75,5.0) z=0, 2.95" of ocean: still `valid: true`. This is the pair that pins the 4" threshold from below; today BOTH cases return true, so it is the only half that does not change.
3. killzones.txt:596 — shooter (13.0,18.0) z=3 (on gantry B) vs target (4.75,14.5) z=0 (bare floor), 2.53" of gantry C's footprint crossed: `valid` is FALSE. Assert `isOnVantage(index, shooterBody)` is true and `isOnVantage(index, targetBody)` is false so the test states its own premise.
4. killzones.txt:596's exception — the same shot but with the TARGET standing inside gantry C's footprint at z=0 (i.e. under it): `valid` is TRUE ("ignore the footprint of gantry terrain features the operative or the intended target is on or in"). And a shot from a point on gantry C itself across gantry C: TRUE.
5. killzones.txt:579 — on bheta-decima-1, features `.A` and `.B` share `groupId 'bheta-decima-1.g2'`. A Vantage shooter standing on `.A` firing across `.B`'s footprint is VALID, because the two are "treated as the same terrain". This is the assertion that pins group handling and it is the one most likely to be got wrong.
6. killzones.txt:604 — a shooter on gantry B (z=3) and a target on gantry C2 (z=3), with gantry C's footprint between them: VALID. Restricted targeting has no effect when both are on Vantage.
7. killzones.txt:578, a data assertion (tests/integration.test.ts): for each of the six maps, every feature whose kind starts with 'bheta.gantry' owns at least one part with `role === 'pillar'` and `types` containing 'Heavy'; and the map's total Heavy part count is > 1.
8. killzones.txt:584, a data assertion: every bheta map's `bheta.condenser` feature owns a part with `role === 'rampart'` and `types` = ['Light'] at z0 = the roof height; and (:583) a part with `role === 'ledge'` — which is where bheta-decima-6 currently fails.
9. Soak: `pnpm soak` must still report zero rejected intents on all six Bheta maps. `validTargets` (shoot.ts:233-250) filters on `check.valid`, so the AI cannot dispatch a newly-invalid shot; the risk is a stall, not a rejection.

### Risk

HIGH-IMPACT, and the numbers say so: the 4" rule denies 38-61% of all floor-to-floor pairs depending on map and reading, and a third gantry's footprint denies 61.1% of Vantage-to-floor pairs on map 1. This is the single largest behaviour change in the cluster. Re-run `pnpm soak` and expect the AI's shooting evaluation to shift materially; a bot that cannot find a target must Reposition rather than stall, so watch for activation loops.

The registry (route A) is a genuine architectural addition. Its blast radius is `createGameContext` and `rebuildHooks`, both of which every test builds through — but it is additive and W-29/W-30/W-31 all want it, so the cost amortises. Route B is smaller but re-opens the "gate by flag or by killzone id" question D-002 settled for Close Quarters.

The data half is a re-extraction: `pnpm maps:extract` rewrites all six committed bheta maps, so every fixture with a hard-coded bheta position must be re-checked. Solid Heavy pillars at floor level BLOCK MOVEMENT under a gantry, which changes `validateMove` pathing and `src/ai/moves.ts` reachability — this is the part most likely to move existing tests, and it is why the pillar footprint size is not a free parameter. Pillars also newly supply Heavy cover and make `obscured` reachable across the board for the first time, which changes defence dice everywhere.

Adding pillars while the gantry decks are still typed 'Light' double-counts cover on some lines. Measure before deciding whether the deck's Light comes out.

The extractor changes are Python outside the vitest suite; `pnpm maps:overlay` + docs/maps/overlays/*.png review against the source cards is the only check on them, per CLAUDE.md.

### OWNER — this cannot land without an answer

THREE, and the item cannot land without the first two.

1. WHAT "IS BETWEEN THEM" MEANS ACROSS TARGETING LINES. killzones.txt:598 says to use targeting lines but does not say how many must be blocked. The three readings and their measured cost, averaged over the six maps: centre-to-centre 48.9%, ANY line crosses >=4" 55.2%, EVERY line crosses >=4" 42.0% of floor-to-floor pairs denied. The engine's own vocabulary is split — `interveningParts` returns `any` (used for cover) and `wholly` (used for obscured). I recommend EVERY line for the hazard half (denying a target outright is the strongest possible effect, so it should need the strongest evidence) and ANY line for the gantry half (a gantry footprint is a solid object, not a gradient). But that is exactly the kind of split an owner should bless rather than infer from a plan.

2. GANTRY PILLAR GEOMETRY. The cards draw only the deck footprint (recorded in data/terrain/bheta-decima.json's own note), so there is no printed pillar position or size. Whatever is chosen becomes `provenance` + `confidence: 'assumed'` alongside D-027's gantry deck height, which the owner has already confirmed once. Concretely: how many legs per deck (I propose 2, at the ends of the long axis), and how wide (I propose ~0.7"). This decides how much of the board becomes shootable-through and how much movement under a gantry is blocked.

3. CONDENSER BATTLEMENT WIDTH. `bheta.condenser.battlement = 3.75"` (0.75" above the roof) is already in the catalogue with `confidence: 'assumed'`; what is missing is the horizontal width of the ring. Same treatment.

Also worth a DECISIONS row (not a blocker): the extractor's addition of 'Light' to gantry deck types, which killzones.txt:577 does not print.

Nothing in docs/DECISIONS.md D-001..D-102 covers Restricted Targeting. D-027 covers only the gantry deck HEIGHT; D-013 the Bheta objective-marker exception; D-054 and D-077 touch Bheta but neither this rule.

### Files

`src/core/visibility.ts`, `src/core/sequences/shoot.ts`, `src/core/killzones/index.ts (new, route A)`, `src/core/killzones/bhetaDecima.ts (new, route A)`, `src/core/context.ts (rebuildHooks — route A)`, `src/core/game.ts (createGameContext — route A)`, `src/core/types.ts (KillzoneMap.restrictedTargeting — route B)`, `tools/maps/terrain.py`, `tools/maps/extract_cards.py`, `data/terrain/bheta-decima.json (regenerated)`, `data/maps/bheta-decima/*.json (regenerated)`, `docs/RULES-COVERAGE.md`, `docs/MAPS.md`, `docs/DECISIONS.md`, `tests/rules-review.test.ts`, `tests/integration.test.ts (data assertions)`


---

## W-33

*Effort: large*

### The rule

```
docs/rules-source/killzones.txt:525-528 (KILLZONE: TOMB WORLD section, heading at :455):
:525 "Teleport Pad"
:526 "A teleport pad is Exposed, Insignificant and Vantage terrain. Only one operative can be on it at once, and whilst an operative is on it, that operative cannot touch the killzone floor (in other words, an operative can't be both on the teleport pad and on the killzone floor). Equipment terrain features cannot be set up within 2\" of a teleport pad. Whenever an operative's base is touching a teleport pad, if another operative is on that teleport pad, those operatives are treated as being within each other's control range."
:528 "From the start of the second turning point, whenever a friendly operative on a teleport pad performs the Charge, Fall Back or Reposition action, you can teleport it. If you do, don't move it. Instead, remove it from the killzone and set it back up on the other teleport pad. It must still fulfil all other requirements of that action, otherwise it cannot teleport (e.g. if it's the Charge action, the operative must finish that action within control range of an enemy operative). If another operative is on the other teleport pad when an operative teleports, swap them around (if it's an enemy operative, its controlling player sets it up). An operative cannot teleport more than once per activation."

And the official FAQ, docs/rules-source/tomb-world.txt:112-113:
"Q: When an operative teleports, is it treated as having moved for the purposes of rules with a distance requirement (e.g. BROOD BROTHER Alpha Predator, PLAGUE MARINE Lumbering Death, VESPID STINGWING Neutron Charge)?  A: No."

Supporting: docs/rules-source/killzones.txt:456 "…2x each other terrain feature specified here. Note that some mission maps use less than this." (why a one-pad map is legal), and killzones.txt:205 "Vantage terrain is the upper levels of the killzone — areas operatives can be placed upon…" with :217 "…so long as part of its base is always on the Vantage terrain" (why partial overhang is normally fine, and therefore why clause 3 needs its own rule).
```

### The original audit entry is wrong about this

Accurate on every count, with only line drift and two additions.

- "OperativeState.onTeleportPadId is declared in types.ts:318" — it is types.ts:334 at HEAD.
- "read in exactly one place — src/core/state.ts:149" — it is state.ts:189 at HEAD. Otherwise exact: `if (a.onTeleportPadId && b.onTeleportPadId && a.onTeleportPadId === b.onTeleportPadId) return true;`
- "assigned NOWHERE in src/" — confirmed by scanning every .ts under src/core for an assignment (as opposed to the `===` comparison): zero hits. `grep -rn onTeleportPadId src/ tests/ data/` returns exactly two lines, the declaration and the read.
- "the wrong condition… the rule is one operative ON the pad and another merely TOUCHING it, whereas the code requires both to be on the same pad, which the one-operative limit forbids" — exactly right, and it is worse than the audit says: the branch ignores distance entirely. With the field forced on both operatives and their centres 15"+ apart, `inControlRange` returns TRUE.
- "no teleport action, no teleport variant… no teleport branch in movement.ts" — confirmed: `/teleport/i` does not match src/core/movement.ts, and the 12 actions offered to an operative standing on a pad in TP2 contain nothing teleport-shaped.
- "nothing enforces the one-operative limit, the 'not on the killzone floor' clause or the 2\" equipment exclusion" — all three reproduced as live.
- "docs/RULES-COVERAGE.md:101 currently claims the control-range half works" — still true at HEAD, now line 107: "Teleport pad (one operative, not on the floor, mutual control range, teleport from TP2) | ◐ … `state.ts::inControlRange` — the teleport move itself is pending". Three of the four things that row credits are unimplemented, not just the move.

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

Drop `padOccupiedBy` and express C2/C3/C5 through the existing selector: `partsSupporting(index, pos, z).find(p => p.role === 'teleportPad')`. Keep `padsTouchedBy` (there is no existing equivalent) but put it in src/core/terrain.ts next to `partsSupporting` so the pair reads as one API, and keep `index.teleportPads` purely as the `length > 0` early-out for the hot `inControlRange` path.

For C4, either route Move With Barricade's placement through `validateEquipmentPlacement` so the unconditional check applies once, or add the same `moreThan2FromTeleportPads` test to src/core/equipment/portableBarricade.ts:72-75 alongside the two 2\" tests already there — and say in the test plan which one, with a fixture that moves a barricade next to a pad.

Restate the C3 owner question with the measured consequence: the strict (base wholly within) reading bars exactly 3 datacards — all EXODITE DRAGON MASTERS on 75×42mm ovals — from teleport pads and therefore from teleporting; every other base in data/teams/** fits, the tightest being 50mm at 0.343\" of slack. Everything else in the plan — derive-don't-cache for C5, C2 being per-board rather than per-player, the killzones.txt:456 justification for one-pad maps, the tomb-world.txt:112-113 FAQ ruling teleport out of the move machinery, the PendingDecision for the enemy swap, and the D-051 note that a teleport rolls no dice and therefore stays undoable — I checked and agree with.

**Why the original plan was rejected.** The strongest of the three reports, and its central corrections to the audit are right — I verified them independently. `grep -rn onTeleportPadId src/ tests/ data/` returns exactly two lines (src/core/types.ts:334, src/core/state.ts:189); the branch has no distance test; and the audit's proposed fix is genuinely disproved — `settleZ` appears in src/core only at src/core/reducer.ts:204, :564 and its definition at src/core/state.ts:374, while `applyMove` sets `op.pos`/`op.z` directly at src/core/actions.ts:152-153, so a cached field would be stale after every Reposition. I also reproduced C2 and C5 myself on data/maps/tomb-world/tomb-world-2.json through the reducer (/tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/adv/w33.test.ts): a second friendly Repositions onto occupied pad T-1 (ok=true, pos (9.511,15.23), z=0.2) with the first still at z=0.2; and for A on the pad at (9.545,15.73) z=0.2 and B touching its east edge at (11.837,16.596) z=0, `gapBetween` = 1.207 and `inControlRange` = **false** where the rule says true. Pad data confirmed (2 pads on maps 2/4/5/6, 1 on maps 1 and 3; 2.312\" square, Exposed+Insignificant+Vantage, z0 0 → z1 0.2, standable). Four objections.

*(Full objection in the git blob above.)*

### Test

tests/rules-review.test.ts, on the real tomb-world-2 map (both pads, T-1 at x 8.905-11.217 / y 14.574-16.886, T-2 at x 16.449-18.761 / y 8.774-11.086), each quoting its clause.

C5, killzones.txt:526 — A at (9.545,15.730) z=0.2 with its base wholly inside T-1; B at (11.837,16.596) z=0 on the killzone floor with its base touching T-1's east edge. Assert `gapBetween(ctx, A, B) > 1` (measured 1.207") so the test proves it is the pad rule and not ordinary control range, then assert `inControlRange(ctx, s, A, B)` AND `inControlRange(ctx, s, B, A)` are both true. Companion negative: move B 0.3" further east so its base no longer touches the pad — both are false. Second negative that pins the backwards branch: A on T-1 and B on T-2 (both ON pads, 15"+ apart) are NOT in control range. That last one FAILS today if the field is ever populated, and is the assertion the current code gets exactly wrong.

C2, killzones.txt:526 — with A on T-1 at (10.53,16.20) z=0.2, a second FRIENDLY dispatching `Reposition {path:{points:[{9.6,16.5},{9.6,15.26}], zs:[0.2,0.2], endZ:0.2}}` is rejected with 'only one operative can be on a teleport pad'; an ENEMY doing the same is rejected too (this is the assertion that separates it from W-31's friendly-only Volkus cap); and the same move finishing 0.2" off the pad at z=0 is accepted. Also `canDeployAt` on an occupied pad is false. All four are accepted today.

C3, killzones.txt:526 (only if the owner takes the strict reading) — `Reposition {points:[{11,17.2},{11,16.5},{11,15.73}], zs:[0,0.2,0.2], endZ:0.2}` is rejected: the 32mm base overhangs T-1's east edge by 0.413" and `surfaceAt(index, {11.317,15.73})` is 0, i.e. killzone floor. The same move ending at the pad centre is accepted. Add the oval case: a 75x42mm operative cannot legally finish on any pad, and assert that explicitly so the consequence is pinned rather than discovered.

C4, killzones.txt:526 — `validateEquipmentPlacement` for a light barricade centred 0.7" from T-1 returns `{ok:false, reason:/teleport pad/}`; at 2.6" it returns ok; and a 20mm MARKER at 0.7" is still ok ("equipment TERRAIN features").

:528 — on tomb-world-2 with A on T-1 in TP2: `Reposition {teleport:true}` sets A up on T-2 and leaves `state.rolls` and the RNG cursor untouched (D-051: teleport must not be a dice event). The same in TP1 is rejected. A second teleport in the same activation is rejected. `Charge {teleport:true}` landing on T-2 with no enemy in control range of T-2 is rejected ("must still fulfil all other requirements of that action"). With an enemy on T-2, the teleport swaps them and raises a PendingDecision whose `who` is the ENEMY's player. On tomb-world-1 (one pad) the teleport option is rejected with 'only one teleport pad'.

Soak: `pnpm soak` on all six tomb-world maps must still show zero rejected intents — `src/ai/legal.ts` runs `def.check` in `push` (legal.ts:289-290), so new rejections can only come from a UI/test driver, not the bot.

### Risk

MEDIUM-HIGH, and the teleport move is the risky third.

C5 is the smallest and the safest: deleting a field that is read once and written never cannot regress anything, and `tsc --noEmit` will find any construction site. The only cost is `inControlRange` gaining two polygon tests on Tomb World; it is O(n^2)-hot (every shot's friendly-control-range block calls it for every friendly), so the `index.teleportPads.length > 0` early-out matters and should be measured, not assumed.

C2 changes `validateMove`'s accepted end positions, which is the same surface W-34/D-102 has just churned 32 tests across 14 files over. Expect tomb-world fixtures that park two operatives near a pad to move. It also narrows `src/ai/moves.ts` reachability on tomb-world maps.

C3 is the one that can quietly break a kill team: on a 2.312" pad a 75x42mm oval cannot fit wholly within, so the strict reading makes teleport pads unusable for every operative on that base — which is a rules consequence, not a bug, but it must be a deliberate one.

C4 is low risk but touches the equipment placement path that D-054 samples ~1,100 times per item to shade the UI; adding an unconditional constraint for terrain items adds a polygon test per sample on Tomb World only.

The :528 teleport is a genuinely new movement mode: 'remove and set up again' bypasses leg building, so every invariant `validateMove` normally enforces at the destination has to be re-asserted explicitly or it is silently skipped. The swap case introduces a new PendingDecision kind, which the AI runner, the UI and `drain()`-style test helpers all have to handle or a bot game will stall. And per D-051 undo is empirical — a teleport that rolls no dice stays undoable, which is correct and should be asserted rather than assumed.

No replay risk from C2-C5; the teleport itself changes positions, so any seeded tomb-world fixture whose game reaches TP2 with an operative on a pad will need re-baselining.

### OWNER — this cannot land without an answer

TWO, and the first blocks C3.

1. HOW STRICT IS "cannot touch the killzone floor"? The engine already models a pad occupant at z=0.2 and a floor operative at z=0, so in one sense the clause is already satisfied and needs no code. The strict reading — the base must be WHOLLY within the pad polygon — has a hard consequence: measured, the pad is 2.312" square, so a 32mm base has 1.052" of slack, a 40mm 0.737", a 50mm 0.343", and a 75x42mm oval (2.953" long) CANNOT fit at all, which bars every large operative from teleport pads and therefore from teleporting. killzones.txt:217 explicitly permits partial overhang on ordinary Vantage terrain ("so long as part of its base is always on the Vantage terrain"), which is why the pad needed its own sentence — that argues for the strict reading — but the owner should confirm before large operatives lose the mechanic.

2. THE SWAP ORDER when both pads are occupied. killzones.txt:528 says "swap them around (if it's an enemy operative, its controlling player sets it up)", which requires a new PendingDecision kind and an answer to what happens if the opponent has no legal placement (the vacated pad is the only candidate, so in practice it is forced — but the decision channel still has to offer something, and architecture rule 3 forbids assuming the active player does everything).

Nothing in docs/DECISIONS.md D-001..D-102 covers teleport pads. D-002 (Close Quarters applies to Gallowdark AND Tomb World) is adjacent but different — teleport pads are a Tomb World terrain rule at killzones.txt:525-528, inside the KILLZONE: TOMB WORLD section that begins at :455, not part of the Close Quarters block that begins at :532 — so `map.closeQuarters` is the wrong gate for them. Gate on the presence of `role: 'teleportPad'` parts in the terrain index instead.

Also worth recording (not a blocker): the audit's own proposed fix — "set op.onTeleportPadId after every position change (settleZ is the natural home)" — is disproved by the code. `settleZ` is called from only reducer.ts:204 and reducer.ts:564, never from the move path, which sets `op.pos`/`op.z` directly at actions.ts:152-153. Following that plan would have left the field stale after every Reposition. Derive, do not cache.

### Files

`src/core/types.ts`, `src/core/terrain.ts`, `src/core/state.ts`, `src/core/movement.ts`, `src/core/actions.ts`, `src/core/reducer.ts`, `src/core/equipment/kit.ts`, `src/core/equipment/index.ts`, `src/ai/legal.ts`, `src/ui/command/`, `docs/RULES-COVERAGE.md`, `docs/DECISIONS.md`, `tests/rules-review.test.ts`


---

## W-36

*Effort: large*

### The rule

```
docs/rules-source/core-rules.txt:301, Place Marker 1AP, verbatim:
  "If an operative carrying a marker is incapacitated, it must perform this action before being removed from the killzone, but does so for 0AP. This takes precedence over all rules that prevent it from doing so."
(with :299 "Place a marker the active operative is carrying within its control range.")

docs/rules-source/core-rules.txt:423, Damage, verbatim and in full:
  "When damage is inflicted on an operative, reduce their wounds by that amount. An operative's starting number of wounds is determined by its Wounds stat (see datacards). If an operative's wounds are reduced to 0 or less, it's incapacitated, then removed from the killzone. Some rules allow an incapacitated operative to perform a free action before being removed from the killzone. Such an operative cannot perform more than one free action (excluding Place Marker) in this instance, and that operative's player decides the order of any of its rules that occur before it's removed from the killzone (taking precedence over the player with initiative deciding)."
docs/rules-source/core-rules.txt:429: "'Incapacitated' and 'removed from the killzone' are separate. Some rules take effect when an operative is incapacitated, but before it's removed."
The "(excluding Place Marker)" parenthesis in :423 is the licence to place MORE than one marker: Place Marker is carved out of the one-free-action cap.

data/ops/tac-ops.json, tac.stealIntelligence `additional`, verbatim:
  "Friendly operatives can perform the Pick Up Marker action on your Intelligence mission markers, and for the purposes of that action's conditions, ignore the first Intelligence mission marker the active operative is carrying. In other words, each friendly operative can carry up to two Intelligence mission markers, or one and one other marker."
```

### The original audit entry is wrong about this

Both halves confirmed live, and the marker half is worse than described — but four statements are wrong at HEAD.

(1) "it runs inside inflictDamage, which is called from the middle of shoot and fight sequences — re-entrancy needs care" is FALSE, and this is the claim that set the item's risk. removeIncapacitated is NOT called from inflictDamage. src/core/state.ts:387 inflictDamage only decrements wounds, sets `target.incapacitated = true` and emits onIncapacitated; then it returns. Removal happens at four places, all already safe points: src/core/reducer.ts:411 via removeIncapacitatedAfterAction (reducer.ts:635, which returns early unless `state.sequence.step === 'done'`), src/core/reducer.ts:645 via finishSequenceIfDone (gated on `state.pending.length === 0`), src/core/reducer.ts:433 in EndActivation, and src/core/phases.ts:234 in endTurningPoint. A blocking PendingDecision raised inside removeIncapacitated therefore never re-enters a live dice sequence. The item is meaningfully less risky than "medium-high".

*(Full correction in the git blob above.)*

### Plan — as corrected by the verifier

COMMIT 1 (the marker sweep) is right and should ship first — the code change is exactly as described and my run proves the loss it fixes. Two additions: (a) the plan's claim that only Steal Intelligence can put two markers on one operative is worth stating as a checked invariant, since every other `marker.carriedBy = op.id` writer (phobos-strike-team:1238, xv26:788, goremonger:1846, farstalker-kinband:1812, wolf-scouts:562, spectre-squad:1600, death-korps:1494, ops/tac/retrieval.ts, core/actions.ts:342) sets `op.carryingMarkerId` in the same breath; (b) note that deleting stealIntelligence.ts:104-108 moves the drop from inflictDamage time to removeIncapacitated time, so anything reading `marker.carriedBy` between those points changes.

COMMIT 2 needs three fixes before it is buildable:
- Hoist the effect helpers, or do not use them. Either move `effect`/`effectOn` into src/core (re-exporting from src/teams/helpers.ts, the shape helpers.ts:288 already uses for FREE_ACTION_RULE), or write the effect with `pushEffect` (hooks.ts:454) and find it with a plain `state.effects.find(e => e.rule === 'incapacitatedFreeAction' && e.operativeId === op.id)`.
- Name where the decision push comes from: export a `pushDecision(state, d)` from a module state.ts may import (types.ts or a new decisions-free helper) and have fight.ts:578 / shoot.ts:866 delegate to it, rather than writing `push(...)` in state.ts.
- Use `expiry: { kind: 'endOfActivation', operativeId }` or clear the effect explicitly in the resolver; `endOfAction` will not expire when the plan assumes.

Add void-dancer-troupe/index.ts:863 to filesToChange and to the test plan: THE CURTAIN FALLS must not null the sequence and teleport while an `incapacitatedFreeAction` decision is pending. Add raveners:688 and tempestus-aquilons:665 to the audit list even if they turn out to be no-ops (operatives incapacitated for the first time inside `onEndOfTP` never went through inflictDamage, so no effect exists and no decision is raised — state that, do not assume it).

Fix the citation to reducer.ts:364, and say explicitly what happens to `onFreeActions` (hooks.ts:318): fold it into the new payload or delete it, in the same change.

The three owner questions are the right ones and none is covered by an existing entry; add a fourth — whether an incapacitated-but-not-yet-removed operative stays in `aliveOperatives` for control range, marker contest and assists during the new window (core-rules.txt:429 supports it, but it must be written down).

**Why the original plan was rejected.** LIVE, both halves — I re-ran the investigator's repros. /tmp/.../scratchpad/w36c.test.ts fails exactly as claimed: after the carrier is swept, `intel-4 carriedBy=undefined` but `intel-9 carriedBy=p1-0` (a removed operative), `carriedIntelligence(p1) = []`, and Pick Up Intelligence on it returns "that marker is already being carried" — a permanent, unrecoverable VP loss. /tmp/.../scratchpad/w36b.test.ts confirms `freeActions` is written by a handler and dropped with no decision, effect, opState entry or log line.

*(Full objection in the git blob above.)*

### Test

Commit 1, in tests/ops.test.ts (its makeGame/act/kill harness is the right shape and already has a Steal Intelligence test at line 322), quoting core-rules.txt:301:
  it('"If an operative carrying a marker is incapacitated, it must perform this action before being removed" — EVERY marker it carries') — reproduce my w36c path exactly: p1 holds tac.stealIntelligence; kill two p2 operatives at (15,11) and (15.6,11) so the op creates two Intelligence markers; one p1 operative performs Pick Up Intelligence twice in SEPARATE activations (the action is treatedAs 'Pick Up Marker' and reducer.ts:122 blocks a repeat within one activation). Assert `Object.values(markers).filter(m => m.carriedBy === carrier).length === 2` and `op.carryingMarkerId === intel[0].id`. Incapacitate the carrier and sweep. Assert for BOTH markers `carriedBy === undefined` and `pos` equal to the carrier's last position; assert `op.carryingMarkerId === undefined`; assert `carriedIntelligence(state,'p1').length === 0` but another p1 operative can now Pick Up Intelligence on EITHER (today the second returns 'that marker is already being carried'); assert two 'places the ... marker before being removed (0AP)' log lines.
  it('a single carried marker still behaves exactly as before') — regression guard for tests/ops.test.ts and the 11 team files that touch carryingMarkerId.

Commit 2, in tests/rules-review.test.ts, quoting core-rules.txt:423:
  it('"Some rules allow an incapacitated operative to perform a free action before being removed"') — register an onIncapacitated handler returning one IncapacitatedFreeAction {action:'Shoot', params:{weaponName, targetId}}; kill the operative through a real Shoot sequence. Assert (i) a PendingDecision kind 'incapacitatedFreeAction' addressed to the DYING operative's player, (ii) `victim.incapacitated === true && victim.removed !== true` while pending, (iii) resolving to the free Shoot spends 0AP (victim.apSpent unchanged) and rolls the shot, (iv) the victim is removed afterwards, (v) state.pending empty.
  it('"cannot perform more than one free action (excluding Place Marker) in this instance"') — a handler returning two entries: both offered, resolving one removes the operative, no second decision follows.
  it('the Place Marker exclusion') — a dying operative with a carried marker AND a free action: the marker is placed whether the free action is taken or skipped.
  it('skip removes it immediately').
  it('the offer is made once even though removeIncapacitated is called from four sites') — drive PerformAction, then EndActivation, then endTurningPoint; exactly one decision was ever raised.
  tests/teams/tempestus-aquilons.test.ts: GUNFIGHT at its printed timing — an Aquilon Gunfighter incapacitated by the very shot that triggered it DOES fire back before removal, and the grantFreeAction approximation is gone from the module.

Re-run tests/ops.test.ts, tests/teams/{raveners,xv26-stealth-battlesuits,ratlings,warpcoven,corsair-voidscarred,wolf-scouts,death-korps,farstalker-kinband,phobos-strike-team,spectre-squad,goremonger}.test.ts (the 11 files referencing carryingMarkerId) and the full soak.

### Risk

Commit 1: low. Only Steal Intelligence can put two markers on one operative today — every other writer of `marker.carriedBy` assigns `op.carryingMarkerId` in the same breath — so for tests/ops.test.ts and the 11 team files that touch carryingMarkerId the new loop does exactly what the old branch did. The one behavioural change beyond the bug is deleting stealIntelligence.ts:104-108, which today drops an ENEMY carrier's markers when your op-owner handler fires; afterwards removeIncapacitated does that for both sides, so mirror games stop behaving differently from non-mirror ones. Check tests/ops.test.ts:322 still passes unchanged.

Commit 2: medium, not medium-high. The audit's stated danger — re-entrancy because removal "runs inside inflictDamage" — does not exist: inflictDamage never removes anything, and all four removal sites are already gated on a finished sequence or an empty pending list. The real risks are:
- A new reducer state (incapacitated && !removed && a decision pending) that every selector must tolerate. `aliveOperatives` filters on `removed`, so a not-yet-removed casualty stays ALIVE for control range, marker contest, visibility and assist counting for the duration of the window. That is arguably correct per core-rules.txt:429 ("'Incapacitated' and 'removed from the killzone' are separate"), but it must be deliberate and written down; src/ui/command/index.tsx:152 already comments on removeIncapacitated marking rather than deleting.
- The free action can start a new sequence (a free Shoot) while `state.sequence` from the killing action is being torn down at reducer.ts:639/646. Perform it from resolveDecision, after those tear-downs, not from inside removeIncapacitated.
- The free action can incapacitate someone else, re-entering removeIncapacitated. The `offered` flag makes it terminate; add a depth guard anyway.
- Widening the onIncapacitated payload touches src/core/hooks.ts, imported by ~30 team modules; the change is additive and nothing writes the field, so it should be type-clean, but run `pnpm typecheck` first.
- Converting the ten REMINDER_ONLY approximations will move team fixtures (Tempestus Aquilons especially, where GUNFIGHT stops banking AP for the next activation). One team per commit, never inside the seam commit.

### OWNER — this cannot land without an answer

Yes — three questions, none covered by an existing entry (docs/DECISIONS.md has nothing on pre-removal; D-022 is the nearest analogue and D-100 governs the free-AP modelling this replaces).

1. WHERE does the forced Place Marker go? core-rules.txt:299/301 says "within its control range", a continuous region, and D-016's precedent is "a killzone position is continuous so it cannot be enumerated as DecisionOptions — use a deterministic, logged default". I recommend keeping the operative's own position (what the code does today, always legal), recorded as a decision. The alternative — a placement decision, which matters when a carrier dies straddling an objective — needs a position channel the engine does not have.

2. Is the pre-removal free action a BLOCKING PendingDecision or an auto-used deterministic policy? D-022 says "'You can use this rule' is auto-used on a stated, deterministic policy when it is free, and raised as a PendingDecision when it costs something". A pre-removal free action IS free (the operative is dying anyway), which argues for auto-use — but Wyrmblade OVERTHROW THE OPPRESSORS is a genuine either/or (a free Shoot, or the A PLAN GENERATIONS IN THE MAKING ploy for 0CP) and Kommandos/Wrecka BOOM! makes the operative shoot its own explosives at a chosen target. My recommendation: a decision, because it is the only pre-removal window in the game and auto-using it would make ten team rules invisible.

3. Retire the D-100/GUNFIGHT approximation in the same change? Today src/teams/tempestus-aquilons/index.ts:889-906 grants free AP at the enemy's end-of-activation and the GUNFIGHTER spends it on its own next activation — which, as its own REMINDER_ONLY at line 228 says, means a GUNFIGHTER killed by that shot never fires back. Fixing the seam makes the approximation unnecessary and wrong (it would double-grant). Retire it, but as its own commit after the seam lands, because it moves the Tempestus Aquilons fixtures.

One rules reading to confirm while deciding: I read "(excluding Place Marker)" in core-rules.txt:423 as licence to place MORE than one marker — Place Marker is carved out of the one-free-action cap, and the Steal Intelligence op text explicitly contemplates carrying two. That is the textual basis for commit 1 placing every carried marker rather than one, and it should be recorded.

### Files

`src/core/state.ts`, `src/core/hooks.ts`, `src/core/decisions.ts`, `src/core/ops/tac/stealIntelligence.ts`, `src/core/actions.ts`, `src/ai/decide.ts`, `src/ui/command/index.tsx`, `src/teams/tempestus-aquilons/index.ts`, `src/teams/wrecka-krew/index.ts`, `src/teams/kommandos/index.ts`, `tests/rules-review.test.ts`, `tests/ops.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`
