# Rules audit — 2026-08-23

A fifteen-domain, line-by-line audit of this implementation against the verbatim Wahapedia text
for Warhammer 40,000 Kill Team 3rd edition. The rules corpus it was read against lives in
`docs/rules-source/` and is gitignored (see the IP note in CLAUDE.md); `tools/` documents how to
re-fetch it. Sixty-two findings survived verification and dedupe to the work items below.

Every item here was checked against the code, not inferred from a doc table — several rules that
`docs/RULES-COVERAGE.md` marked implemented turned out to do nothing at all. Items marked FIXED
have a test that fails against the commit before them; the rest are open.

## Domains swept

Fifteen domains, each read line by line against its slice of the corpus:
movement and terrain · visibility, cover and obscured · the Shoot sequence · the Fight sequence ·
the 23 universal weapon rules · turn structure and the CP economy · the universal actions ·
operative state (APL, wounds, orders, control range, markers) · universal equipment ·
the crit ops · the tac ops, kill op, primary op and initiative cards · Killzone: Volkus and
Compound Siege · Killzone: Gallowdark and Close Quarters · Killzone: Bheta-Decima and Tomb World ·
the mission sequence and roster constraints.

## Work items

Ranked by how much each defect distorts a real game.

| # | Status | Layer | Severity | Item |
| --- | --- | --- | --- | --- |
| W-01 | open | data | critical | Gallowdark and Tomb World maps ship almost no hatchway/breach access points, and the ones that exist are not gaps in the wall |
| W-02 | FIXED `3f93c80` | engine | critical | Operate Hatch and Breach can never be performed on any map — both `available` predicates test for things the data never contains |
| W-03 | FIXED `3f93c80` | engine | critical | No Gallowdark or Tomb World wall can ever intervene — the 0.6" minimum-edge filter discards every 0.365"-thick wall's corners and ends |
| W-04 | open | data | critical | Volkus stronghold walls are extruded to the building's maximum height, so both Vantage levels are blind on all six maps |
| W-05 | open | mixed | critical | No crit-op mission action can be performed in the shipped UI — five of nine crit ops score 0VP for a human player |
| W-06 | FIXED `1978520` | engine | critical | Limited x never exhausts a weapon — weaponExhausted() has no call sites |
| W-07 | FIXED `1978520` | engine | critical | Heavy only blocks shooting after moving, never moving after shooting |
| W-08 | FIXED `1978520` | engine | critical | Pick Up Marker only checks that the TEAM controls the marker, so any operative lifts it from anywhere on the board |
| W-09 | FIXED `1978520` | engine | critical | Mines only detonate where a move ends — an operative walks straight over the marker with impunity |
| W-10 | open | engine | critical | Smoke Grenade markers can be placed where the thrower cannot see, and take the thrower's height instead of the ground's |
| W-11 | FIXED `1978520` | engine | critical | The initiative roll-off is rolled twice every turning point, and the discarded first roll decides the real roll-off's tie |
| W-12 | FIXED | engine | critical | An On Guard point-blank shot is decided on raw base distance and then bypasses the visibility gate, so an on-guard operative shoots through a Gallowdark wall |
| W-13 | FIXED | engine | major | On Guard is not limited to once per enemy activation — every on-guard operative can interrupt the same activation |
| W-14 | FIXED | engine | major | Hatchway Fight never checks the target is within 2" of, or on the other side of, the access point — it is a 1AP melee attack on anyone on the board |
| W-15 | FIXED | engine | major | Declining one counteract window burns every counteract for the rest of the turning point |
| W-16 | FIXED | engine | major | "Until the end of the turning point" effects are deleted before the crit op reads marker control at the end of that turning point |
| W-17 | FIXED | engine | major | Melee Devastating fires only for criticals actually used to strike, and ignores the distance-prefixed form entirely |
| W-18 | open | engine | major | A Charge may clip a lone enemy's control range and finish on a different enemy — `stickyEngagedWith` is written and read nowhere |
| W-19 | FIXED `10509af` | engine | major | The Accessible +1" is charged for every increment that merely starts or ends on Accessible terrain, and only once when two parts are crossed |
| W-20 | FIXED `10509af` | engine | major | Vertical movement is unvalidated: `path.endZ` teleports for free, and a jump to a feature 1" higher is charged as a 2" climb and banned during a Dash |
| W-21 | open | engine | major | The retaliating operative still cannot choose among its melee weapons — 64 of 454 datacards are locked to card order |
| W-22 | open | engine | major | Razor wire is built as solid terrain, so the Obstructing +1" is computed and then thrown away and the wire cannot be crossed at all |
| W-23 | open | engine | major | The portable barricade gives cover to anyone behind it — the "only while an operative is connected to it" gate is never implemented |
| W-24 | open | engine | major | Smoke's Piercing softening adds a defence die unconditionally, so Piercing Crits 2 into smoke always faces 4 dice |
| W-25 | open | engine | major | Kill grade is a one-way ratchet — a REANIMATED operative never lowers the opponent's grade or takes back the VP |
| W-26 | open | engine | major | The kill grade row is recomputed from the live roster, so operatives added mid-battle push the enemy onto a harder row |
| W-27 | FIXED | engine | major | Reboot can be performed while within control range of an enemy operative |
| W-28 | open | engine | major | Breach performs no control-range check and its concussion roll hits operatives on the breacher's own side of the wall |
| W-29 | open | engine | major | Volkus has no killzone module: Garrisoned Stronghold and Condensed Stronghold are entirely unimplemented |
| W-30 | open | engine | major | The DOOR FIGHT universal action does not exist, so one operative in a doorway seals every building on Volkus |
| W-31 | open | engine | major | Stronghold B's highest level accepts any number of operatives — `maxOperatives` is data-only |
| W-32 | open | mixed | major | Bheta-Decima Restricted Targeting is unimplemented, and with no gantry pillars in the data the killzone has one Heavy part in total |
| W-33 | open | engine | major | Tomb World teleport pads are inert scenery, and the mutual-control-range clause is dead code written backwards |
| W-34 | open | engine | major | A move may finish with two bases fully overlapping — the end-of-move overlap guard is a dead comparison |
| W-35 | FIXED | engine | major | Operative-to-operative distance is horizontal only, so an operative on 3" Vantage terrain is in control range of one on the floor below |
| W-36 | open | engine | major | An incapacitated operative gets no pre-removal step: granted free actions are dropped and only one carried marker is placed |
| W-37 | open | engine | minor | Gambit alternation is not enforced by the reducer, and the AI driver lets the initiative player use every gambit first |
| W-38 | open | engine | minor | A granted free action is modelled as +1 APL, so the ±1 clamp cancels it against any other APL change |
| W-39 | FIXED `10509af` | engine | minor | The Ceiling "regardless of the operative's height" exemption is still dead at the final-placement check |

## Detail

### W-01 · Gallowdark and Tomb World maps ship almost no hatchway/breach access points, and the ones that exist are not gaps in the wall

**OPEN** · data · critical

Rules pinned: `killzones.txt:429-441 (Hatchway: access point + hatch, closed/open types)`; `killzones.txt:482,:503 (Tomb World hatchway / breach point)`; `killzones.txt:464 ("Operatives cannot move over or through Wall terrain")`

**Problem.** Verified still open. Across the six Gallowdark maps there are 59 hatch-bearing wall pieces but only 6 accessPoint parts (gallowdark-3 and -6 have zero), and no map anywhere contains a role:'hatch' part. Across the six Tomb World maps there are 0 accessPoint parts of any kind, though data/terrain/tomb-world.json declares hatchways on wallA3/A4/B3 and breach points on wallA1/B2. Where an access point does exist it sits BESIDE the wall band rather than notching it (gallowdark-1.B2-1.wall spans y 19.380-19.745; .access spans y 19.759-20.826), so Operate Hatch changes nothing — wallRouteDistance across it is Infinity open or closed. tools/maps/extract_cards.py finds access points only by masking the single colour PALETTE['hatch_cq'], which never matches on Tomb World cards. Net effect: two of the four killzones are permanently sealed into disconnected rooms; on tomb-world-2 an operative with a 100" budget reaches 706 cells in its own quadrant and the centre objective is unreachable.

**Fix.** In tools/maps/extract_cards.py: (a) derive the hatchway/breach point from the piece kind (T.PIECES[kind]['hatch'] / ['breach']) rather than from a successful colour match, falling back to the canonical mid-span position in data/terrain/<killzone>.json when the pill is not found; (b) add the Necron portal pill's RGB to cardlib.PALETTE and mask both colours; (c) emit the wall as two polygons that stop either side of the access point, with the access-point box occupying the wall band itself (same y-extent as the wall), plus a sibling role:'hatch' part carrying ['Heavy','Wall'] for the open panel. This is the same extractor family as KNOWN-2 (the Volkus door derived from the gap in the wall ring, already landed in 3d22ad2) — do it with the same person while the extractor is in their head. Then pnpm maps:extract && pnpm maps:overlay and update the QA table in docs/MAPS.md.

**Risk.** Highest-risk item in the plan. Re-extraction perturbs every wall polygon on 12 maps, so terrain-dependent tests and docs/ui-review captures move with it. Splitting one wall into two polygons also doubles the wall-part count, which interacts directly with W-03 (wall corner/end zones) — land W-03's principal-axis logic first or the new end faces will be silently discarded too.

Files: `tools/maps/extract_cards.py`, `tools/maps/cardlib.py`, `data/maps/gallowdark/*.json`, `data/maps/tomb-world/*.json`, `data/terrain/tomb-world.json`, `docs/MAPS.md`

Test: A data-lint test in the shape of the existing /home/user/kill-team-mobile/tests/maps-volkus-doors.test.ts: for every map, every feature whose catalogue entry has hasHatchway or hasBreachPoint owns exactly one role:'accessPoint' part, and that part's polygon intersects its feature's wall polygon. Plus a reachability test quoting killzones.txt:429 — with every access point set open, every killzone-floor cell on each Gallowdark/Tomb World map is reachable from every other.

### W-02 · Operate Hatch and Breach can never be performed on any map — both `available` predicates test for things the data never contains

**FIXED** · engine · critical

Rules pinned: `killzones.txt:496 (Operate Hatch)`; `killzones.txt:517 (Breach)`

**Problem.** Verified still open at src/core/actions.ts:452 and :492. Operate Hatch gates on `p.role === 'accessPoint' && p.feature.kind.includes('hatch') !== false` — feature kinds are 'gallowdark.wallA3' / 'tomb-world.wallA3', so `kind.includes('hatch')` is always false and `false !== false` is false: the predicate can never be satisfied. Breach gates on `p.role === 'breachWall'`, and no map or terrain JSON anywhere contains that role — the extractor emits one part per doorway with role:'accessPoint' and the discriminator in a separate `opensAs` field, which src/core/types.ts does not declare and the core never reads. Breach's perform() then flips a role:'breachWall' sibling that does not exist. reducer.ts rejects a PerformAction whose def.available is false and availableActions() drops it from both the UI menu and the AI candidate list, so this is an independent second cause of the sealed board: even the three correctly-extracted gallowdark-1 hatchways can never be opened.

**Fix.** Add `opensAs?: 'hatch' | 'breachWall'` to TerrainPart in src/core/types.ts (the field is already in the map JSON and survives JSON.parse and the spread in buildTerrainIndex). Gate Operate Hatch on `parts.some(p => p.role === 'accessPoint' && p.opensAs === 'hatch')` and Breach on `parts.some(p => p.role === 'accessPoint' && p.opensAs === 'breachWall' && p.state !== 'open')`. Make Breach's perform() flip the accessPoint itself instead of hunting a breachWall sibling.

**Risk.** Low and self-contained. Verifiable today on gallowdark-1 without waiting for W-01; the Breach half stays untestable until W-01 emits Tomb World access points.

Files: `src/core/types.ts`, `src/core/actions.ts`

Test: tests/rules-review.test.ts, quoting killzones.txt:496 ("Open or close a hatchway thats access point is within the operative's control range"): on the shipped gallowdark-1 map, getAction('Operate Hatch').available(...) is true and an operative standing within 1" of gallowdark-1.B2-1.access opens it, and effectivePart flips its types to Accessible+Insignificant+Exposed. Mirror for Breach on a tomb-world wallA1 once W-01 lands.

### W-03 · No Gallowdark or Tomb World wall can ever intervene — the 0.6" minimum-edge filter discards every 0.365"-thick wall's corners and ends

**FIXED** · engine · critical

Rules pinned: `killzones.txt:413-426 ("only the corners and ends of Wall terrain can intervene"; "An end of the wall is intervening, therefore operative B is in cover")`

**Problem.** Verified still open at src/core/terrain.ts (wallCornerZones, minEdge = 0.6, radius = 0.35): `if (dist(prev, cur) < minEdge || dist(cur, next) < minEdge) continue;`. Every extracted wall part is a rectangle 0.365-0.366" thick, so both vertices at each end of a wall have one adjacent edge of 0.365" and are discarded. wallCornerZones returns [] for all 94 role:'wall' parts across the six Gallowdark maps, and interveningParts does `if (polys.length === 0) continue;` — the wall is dropped from inter.any entirely, so it supplies neither cover nor obscured. On the killzones where walls are essentially the only terrain, nobody is ever in cover and nobody is ever obscured: every ranged attack resolves with no cover save and no discarded success. Reproduced: identical positions give inCover:false at 0.365" thickness and inCover:true at 1".

**Fix.** Stop deriving 'corner or end' from absolute edge length. Compute the part's principal axis (oriented bounding box long direction); treat the two end faces plus any vertex where the long-axis direction turns by more than ~30 degrees as corner/end zones, and reject only vertices belonging to protrusions whose extent perpendicular to the principal axis is small relative to the wall's own thickness. Scale `radius` off the wall thickness instead of a fixed 0.35". The minimum viable change is `Math.max(dist(prev,cur), dist(cur,next)) < minEdge`, which restores the two end zones on a thin-but-long wall.

**Risk.** Medium. This turns cover ON across two killzones that currently have none, so AI evaluation and soak win-rates will shift and any Gallowdark team test that implicitly assumed no cover will move. Land before W-01 so the re-extracted split walls inherit correct behaviour.

Files: `src/core/terrain.ts`, `src/core/visibility.ts`

Test: tests/rules-review.test.ts quoting killzones.txt:424 and :426, built on a wall of the REAL shipped thickness (0.365"): two operatives peeking round the end of it — the end is intervening, so the target is in cover; and a target 2" clear of the same end, more than 1" from both operatives, is obscured. Guard the regression with an assertion that wallCornerZones returns 2+ zones for every role:'wall' part in data/maps/gallowdark/*.json.

### W-04 · Volkus stronghold walls are extruded to the building's maximum height, so both Vantage levels are blind on all six maps

**OPEN** · data · critical · **needs an owner decision**

Rules pinned: `killzones.txt:258 ("The small broken ramparts on the edge of the Vantage terrain of Stronghold A are Insignificant and Exposed terrain")`; `killzones.txt:232 (Exposed: "For the purposes of cover and obscured, it's never intervening")`; `killzones.txt:205-207 (Vantage)`

**Problem.** Verified still open in the shipped data: every volkus-N.json Stronghold A wall part runs z0=0 to z1=5.906 and every Stronghold B wall part z0=0 to z1=7.48, while their Ceiling+Vantage floors sit inside that ring at z=3.0 and z=6.0. The edge of every Vantage level is therefore a 2.9"/4.5" opaque Heavy parapet. Measured on volkus-1: the best spot on Stronghold A's upper level sees 29 of 481 legal floor positions (6%); cap that feature's walls at the level they enclose and it sees 295/481. Stronghold B: 91/481 vs 201/481 (lower) and 118/481 vs 244/481 (top). Climbing either stronghold — the two biggest features on all six maps — is a pure downside, and Vantage's Accurate 1/2 is unreachable from them. Keys C (fire steps), D (broken vent), E (barrel containers) and F (the broken ramparts) are not extracted at all; they survive only as prose in the `notes` array of data/terrain/volkus.json. Note the doors themselves are now correct — KNOWN-2 landed in 3d22ad2 (4 role:'door' Accessible+Heavy parts per map).

**Fix.** In tools/maps/terrain.py stop extruding the whole traced ink ring to volkus.strongholdX.top. Emit per-level wall bands (ground z0=0 to level1, upper z0=level1 to level2), keeping a tall Heavy prism only for the silo/tower footprint that actually reaches 5.906"/7.48". Add the parts the rules name: key F ramparts as ['Insignificant','Exposed'] and key C fire steps as ['Vantage','Insignificant','Exposed'] (terrain.ts already treats both as non-blocking), key D broken vent as Blocking and key E barrel containers as Blocking+Heavy. Record heights with provenance + confidence in data/terrain/volkus.json.

**Risk.** Medium-high, and partly a judgement call on where each level's wall band stops — the cards do not print band heights, so the new numbers need provenance + confidence like every other terrain height. Re-extraction moves polygons under docs/ui-review captures and the Volkus terrain tests.

Files: `tools/maps/terrain.py`, `data/terrain/volkus.json`, `data/maps/volkus/*.json`, `docs/MAPS.md`

Test: A map-quality test alongside tests/maps-volkus-doors.test.ts quoting killzones.txt:205-207: for every Volkus map and every stronghold Vantage floor, at least one standable spot on that floor has line of sight to more than 40% of the killzone-floor grid. Plus a unit test that no wall part of a stronghold has z1 greater than the highest floor it encloses, except the silo footprint.

### W-05 · No crit-op mission action can be performed in the shipped UI — five of nine crit ops score 0VP for a human player

**OPEN** · mixed · critical

Rules pinned: `the-missions.txt:171 (Loot)`; `approved-ops-2025.txt:100 ("Score VP by performing mission actions and controlling objective markers")`

**Problem.** Verified still open. NEEDS_TARGET in src/core/actions.ts lists only the twelve movement/shoot/fight/marker actions — no mission action appears in it. actionAvailability therefore falls through to `row.def.check(ctx, state, op, {})` with empty params, the op's check returns {ok:false, reason:'select an objective marker'}, and the row comes back ok:false with needsTarget undefined. activationPlan renders it `disabled={!ok}` and its onClick dispatches `perform(def.id)` with no params; only isMoveAction ids get an aiming step. `grep -rn markerId src/ui/` returns nothing — there is no marker-aiming screen anywhere. Confirmed for Secure, Loot, Initiate Transmission, Download, Compile Data, Send Data and Reboot: reduce() with {markerId} succeeds, so the actions are legal; the UI simply cannot dispatch them. Move Orb is worse — it needs params.choice, and neither the UI nor missionCandidates in src/ai/legal.ts ever produces one, so the Orb token is frozen on the centre marker for the whole battle in bot games too (four full games on seeds 3/7/11/19 logged zero 'moves the Orb token' entries). Up to a 6VP swing per player in an 18-21VP game.

**Fix.** Add every marker-taking mission action to NEEDS_TARGET as 'marker' (Secure, Loot, Initiate Transmission, Move Orb, Download, Compile Data, Send Data, Reboot and the tac-op ones). Give activationPlan a marker-aiming branch alongside ui.move / ui.weaponName that lists the objective markers the active operative controls — via a named core selector, per the CLAUDE.md rule that the UI may not re-implement one; `activeControls` already exists in src/core/ops/common.ts:150 and wants a plural wrapper. Move Orb needs a second step supplying params.choice, and missionCandidates should enumerate {markerId, choice} as well as {markerId}.

**Risk.** Low engine risk, real design work in the UI: this is a new aiming mode in a shell that has deliberately exactly one screen per state (docs/UI.md). Re-capture docs/ui-review afterwards and look at it.

Files: `src/core/actions.ts`, `src/ui/command/play.tsx`, `src/core/ops/common.ts`, `src/ai/legal.ts`, `docs/UI.md`

Test: A UI-level test in the shape of tests/allocate.test.tsx quoting the-missions.txt:171: for each of the nine crit ops, an operative legally controlling the right marker in the right turning point gets an actionAvailability row with ok=true (or needsTarget='marker'), and the plan's dispatch carries params.markerId. Plus an ops test asserting a bot game with critOpId='crit.orb' logs at least one 'moves the Orb token'.

### W-06 · Limited x never exhausts a weapon — weaponExhausted() has no call sites

**FIXED** · engine · critical

Rules pinned: `appendix.txt:200 ("After an operative uses this weapon a number of times in the battle equal to x, they no longer have it")`

**Problem.** Verified still open: `grep -rn weaponExhausted src/` returns only its own definition at src/core/state.ts:213. finishShoot increments attacker.weaponUses[weaponName] and nothing ever reads it; weaponsOf() returns every weapon on the datacard regardless of the count, and Shoot's check() never consults it. The Fight sequence does not increment weaponUses at all, so the three melee Limited weapons never even accumulate a count. Six team modules re-implement the check inside their own availableWeapons hooks, masking the hole for those teams only — the other twelve Limited-bearing teams can throw the same Melta bomb, Demolition charge, C8 HX charge, Fusion grenade or Terrorchem vial in all four turning points. These are the highest-damage profiles in the game and their whole balance is the single use.

**Fix.** Filter inside weaponsOf() (src/core/state.ts:185): after the loadout/hook filtering, drop any weapon all of whose profiles are weaponExhausted(op, w, profile). One change routes it through Shoot's check, Fight's check, the AI's legal-intent enumeration and the UI at once. Then mirror shoot.ts's `useCounted` bookkeeping in the Fight sequence so melee Limited weapons are counted once per Fight action.

**Risk.** Low, but it will expose the six team modules that already do this themselves — check none of them now double-count. Any team test that fires a Limited weapon twice was pinning the bug.

Files: `src/core/state.ts`, `src/core/sequences/fight.ts`

Test: tests/rules-review.test.ts quoting appendix.txt:200: an operative with a Limited 1 demolition charge shoots with it, and in its next activation weaponsOf(...,'ranged') no longer lists it and a Shoot intent naming it lands in state.rejected. A second case for a melee Limited weapon across two Fight actions, and a third asserting a Blast action counts as one use.

### W-07 · Heavy only blocks shooting after moving, never moving after shooting

**FIXED** · engine · critical

Rules pinned: `appendix.txt:191 ("An operative cannot use this weapon in an activation or counteraction in which it moved, and it cannot move in an activation or counteraction in which it used this weapon")`

**Problem.** Verified still open at src/core/actions.ts:331-341. Only the first half exists: Shoot's check refuses a Heavy weapon when op.actionsThisActivation already contains a move action. Nothing refuses a move once a Heavy weapon has been used — the Reposition, Dash, Fall Back and Charge checks never look at what was shot. So a Scout Heavy Gunner shoots from a vantage point for 1AP and then Repositions 6" back out of line of sight, the shoot-and-scoot KT24 exists to forbid, across all 127 Heavy profiles in data/teams. Line 334 also reads `profile.rules` directly rather than effectiveRules(...), so a hook-granted or hook-removed Heavy is invisible to even the half that is implemented, and the `Heavy (x only)` clause is not honoured in either direction.

**Fix.** Record which weapon each Shoot used — the sequence already knows seq.weaponName; push it onto the operative as op.weaponsUsedThisActivation (cleared with apSpent/actionsThisActivation in ActivateOperative and Counteract). Add a shared guard to moveCheck()/applyMove() at src/core/actions.ts:88: if any weapon used this activation has Heavy, refuse the move unless heavy.only names this exact move action. Read the rule off effectiveRules(...) in both directions.

**Risk.** Low mechanically, but it removes a move the AI currently plans, so src/ai/moves.ts and legal.ts must learn the restriction or soak games will fill state.rejected — and the acceptance tests assert that count is zero.

Files: `src/core/actions.ts`, `src/core/types.ts`, `src/core/reducer.ts`, `src/core/sequences/shoot.ts`

Test: tests/rules-review.test.ts quoting appendix.txt:191 in both directions: (a) Shoot then Dash is rejected; (b) with `Heavy (Dash only)`, Shoot then Dash is accepted and Shoot then Reposition is rejected; (c) a hook that grants Heavy at runtime is honoured by the move guard, pinning the effectiveRules half.

### W-08 · Pick Up Marker only checks that the TEAM controls the marker, so any operative lifts it from anywhere on the board

**FIXED** · engine · critical

Rules pinned: `core-rules.txt:292 / approved-ops-2025.txt:382 ("Remove a marker the active operative controls")`; `core-rules.txt:540 ("Operatives contest markers within their control range")`

**Problem.** Verified still open at src/core/actions.ts:270: the check is `markerController(ctx, state, marker) !== op.player` — a team-level question answered by the total APL of everyone contesting the marker. It never asks whether the ACTIVE operative contests it, though markerContestedBy is already imported in the same file at line 20 and used by checkMines at line 140. perform() then does `marker.pos = {...op.pos}`, so the marker teleports to a distant operative. src/ai/legal.ts:180-185 repeats the identical filter, so bot games exercise it whenever a teammate stands on a pick-up marker. Reproduced: an operative 21" away picked up an Energy Cells objective and the marker relocated to it. The same hole harvests Retrieval and Steal Intelligence markers (1VP each at end of battle) and lets an enemy remotely lift a planted Banner. Pick Up Intelligence (src/core/ops/tac/stealIntelligence.ts:55) has the mirror-image gap — it checks contest but not control.

**Fix.** Use the helper that expresses the rule: `activeControls(ctx, state, op, marker)` (src/core/ops/common.ts:150 — contest AND team control), in the Pick Up Marker check and in the src/ai/legal.ts enumerator. Add the missing controller half to Pick Up Intelligence at the same time. perform()'s `marker.pos = {...op.pos}` then becomes harmless because the marker is already within 1".

**Risk.** Low. Watch for tac-op tests that pick up a marker from a convenient distance.

Files: `src/core/actions.ts`, `src/ai/legal.ts`, `src/core/ops/tac/stealIntelligence.ts`

Test: tests/rules-review.test.ts quoting core-rules.txt:292: two friendly operatives, one on the marker and one 12" away; the near one's Pick Up Marker is accepted, the far one's lands in state.rejected with a named reason, and the marker never moves. Mirror for Pick Up Intelligence.

### W-09 · Mines only detonate where a move ends — an operative walks straight over the marker with impunity

**FIXED** · engine · critical

Rules pinned: `universal-equipment.txt:112 ("The first time that marker is within an operative's control range, remove that marker and inflict D3+3 damage on that operative")`

**Problem.** Verified still open. checkMines(ctx, state, op) is called once in applyMove at src/core/actions.ts:124, AFTER `op.pos = {...v.endPos}`, and tests markerContestedBy against that single end position. The validated path (v.legs, each with from/to/fromZ/toZ) is never examined. A Reposition from (4,9) straight to (10,9) over a mine at (7,9) does not fire it, the marker stays on the board and the operative takes no damage — a once-per-battle 4-6 damage trap is neutralised by simply not stopping beside it, and can be crossed repeatedly all battle. This is a SEPARATE code path from the KNOWN-1 terrain-leg work: checkMines is not called from validateMove at all, so fixing leg checking there will not fix this.

**Fix.** Walk v.legs in applyMove and call checkMines per leg: for each untriggered mine, sample the swept base along leg.from -> leg.to at leg.fromZ/toZ and trigger at the first sample within control range. The path-sampling loop added for the enemy check (enemyOnTheWay, src/core/movement.ts:317) is the pattern to copy, including its cheap distancePointToSegment rejection. Apply the same treatment wherever else a rule repositions an operative.

**Risk.** Low. Slight RNG-order change in any replay where a mine now fires earlier — expected and covered by the seeded-replay test.

Files: `src/core/actions.ts`, `src/core/movement.ts`

Test: tests/rules-review.test.ts quoting universal-equipment.txt:112: a mine at (7,9), a Reposition from (4,9) to (10,9) that finishes 3" past it — the marker is removed, D3+3 damage is inflicted, and the operative still finishes at (10,9) because the mine does not stop the move.

### W-10 · Smoke Grenade markers can be placed where the thrower cannot see, and take the thrower's height instead of the ground's

**OPEN** · engine · critical

Rules pinned: `universal-equipment.txt:156 ("Place one of your Smoke Grenade markers within 6\" of this operative. It must be visible to this operative, or on Vantage terrain of a terrain feature that's visible to this operative")`

**Problem.** Verified still open at src/core/equipment/grenades.ts. The check tests only: no enemy in control range, the kill team's remaining smoke allowance, and `dist(op.pos, pos) > 6`. There is no visibility test — isVisible is imported in this file but used only by the Stun Grenade. Proved: a marker was placed 5" away on the far side of a 10"-tall solid Heavy wall after asserting isVisible(...).visible === false for a body on that point. Separately perform() writes `z: op.z`, the THROWER's height, and whollyWithinSmoke requires `b.z >= s.z0` — so smoke dropped from a 4" gantry onto the floor does nothing at all to anyone standing in it.

**Fix.** In check(), after the range test, require isVisible(terrain(ctx,state), body(ctx,op), pointBody(pos, z)) or the Vantage-terrain alternative, reusing the selector the Stun Grenade already calls. In perform(), set z from the surface height at the chosen point (the same helper the onKillzoneFloor constraint uses) rather than op.z, and accept an explicit z param for a marker deliberately placed on Vantage terrain.

**Risk.** Low. The AI's grenade candidate enumeration must filter on the same predicate or soak games gain rejected intents.

Files: `src/core/equipment/grenades.ts`, `src/core/visibility.ts`

Test: tests/equipment.test.ts quoting universal-equipment.txt:156: (a) a target point behind a solid Heavy wall, 5" away — the action is rejected; (b) an operative on a 4" gantry places smoke on the floor 5" away and a floor-level operative standing in it is whollyWithinSmoke.

### W-11 · The initiative roll-off is rolled twice every turning point, and the discarded first roll decides the real roll-off's tie

**FIXED** · engine · critical

Rules pinned: `core-rules.txt:170 ("if the roll-off is a tie, the player who didn't have initiative in the previous turning point decides")`; `approved-ops-2025.txt:129-132 ("the players roll off (but don't re-roll ties)"; "the player who doesn't currently have initiative is the winner")`

**Problem.** Verified still open at src/core/reducer.ts:66-82. `case 'RollOff'` unconditionally calls rollInitiative(ctx, next) — two d6, recorded into state.rolls and logged, and emitting initiativeRollModifiers for both players — assigns next.initiative from it, and THEN calls ctx.beginInitiative, which rolls a second independent pair and runs the real Approved Ops roll-off. One RollOff intent consumes 4 RNG draws and records two kind:'initiative' rolls with the same TP note. The real roll-off's tie-break, rollOffLoser, reads state.initiative — which the phantom roll has already overwritten — so a tie is decided by the discarded roll's winner rather than by who held initiative last turning point. Worse, once-per-battle roll-off modifiers (BLADES OF KHAINE Rune of Prophecy, BROOD BROTHER Mastermind) are consumed on the discarded emit and return false on the second, so they are spent for zero effect.

**Fix.** In the Approved Ops path, let ctx.beginInitiative be the only roll: when next.phase !== 'setup' and ctx.beginInitiative is present, skip rollInitiative entirely and leave next.initiative untouched so initiativeCards.ts tie-breaks against the previous turning point's holder. Keep rollInitiative for the setup roll-off (which does re-roll ties) and as the fallback when no beginInitiative seam is wired. Also stop assigning initiative to the roll-off winner at reducer.ts:76 — the rule is that the winner DECIDES who has it, and completeInitiative is the single place it changes hands.

**Risk.** Medium: halving the RNG draws per turning point re-seeds every downstream roll, so every recorded replay and every seeded acceptance/soak expectation shifts. Do it in its own commit and re-baseline the fixtures deliberately.

Files: `src/core/reducer.ts`, `src/core/ops/initiativeCards.ts`, `src/core/phases.ts`

Test: tests/rules-review.test.ts quoting core-rules.txt:170: with ScriptedRng [1,6,3,3] and state.initiative='p1' entering TP2, exactly one kind:'initiative' entry is recorded, the RollOff consumes exactly 2 RNG draws, and the 3-3 tie hands chooseInitiative to p2. A second case with [6,1,3,3] must give the same answer, proving the tie no longer depends on a discarded roll.

### W-12 · An On Guard point-blank shot is decided on raw base distance and then bypasses the visibility gate, so an on-guard operative shoots through a Gallowdark wall

**FIXED** · engine · critical

Rules pinned: `killzones.txt:411 ("Visibility cannot be determined over or through Wall terrain")`; `killzones.txt:557-558 (point-blank shot: "Target the enemy operative within your operative's control range")`

**Problem.** Verified still open at src/core/reducer.ts:443. OnGuardInterrupt computes `const pointBlank = baseGap(op…, target…) <= 1` — pure base-to-base distance, no visibility, no control-range test — and passes it into startShoot, where it skips the visibility gate, the friendly control-range block, the Conceal+cover gate and the whole normal target-validity branch. Gallowdark walls are 0.365" thick, so almost any pair hugging opposite faces is inside the 1" gap: proved with isVisible false and inControlRange false, the interrupt was accepted with pointBlank true. On-guard operatives can shoot through the walls of the killzone at will, and the same shot silently skips the Conceal/cover checks.

**Fix.** Derive point-blank from control range, not distance: `const pointBlank = inControlRange(ctx, next, op, target)` (src/core/state.ts:139, which goes through withinControlRange and therefore honours the Wall visibility block). Gate the flag on the shooter actually being engaged, and in src/core/sequences/shoot.ts keep the visibility check even when pointBlank is set — the point-blank exemption is from the Shoot action's engagement condition and the Conceal-in-cover target-validity rule, not from visibility itself.

**Risk.** Low. Sits next to W-13 in the same reducer case — same engineer, but keep them separate commits so the point-blank change is bisectable.

Files: `src/core/reducer.ts`, `src/core/sequences/shoot.ts`

Test: tests/rules-review.test.ts quoting killzones.txt:411: a 0.365" wall between an on-guard operative and the active enemy 0.74" away — isVisible false, inControlRange false, and the OnGuardInterrupt is rejected. Companion case with no wall: accepted, pointBlank true, Hit worsened by 1.

### W-13 · On Guard is not limited to once per enemy activation — every on-guard operative can interrupt the same activation

**FIXED** · engine · major

Rules pinned: `killzones.txt:553 ("Once during each enemy operative's activation, after that enemy operative performs an action, you can interrupt that activation and select ONE friendly operative on guard…")`

**Problem.** Verified still open at src/core/reducer.ts:431-450. OnGuardInterrupt validates only that the named operative is friendly and on guard and that an enemy is active. The only bookkeeping is per-operative (op.onGuard = false; op.guardSpentTP), plus a cosmetic `delete opState['guardOffer']` that the intent never requires. offerGuardInterrupt re-publishes a fresh offer after every action the active operative performs, listing whichever operatives are still on guard. Proved: two interrupts against the same active operative both accepted, and two can be dispatched back to back with no intervening action. A three-operative overwatch net fires three free Shoots into one 2AP activation instead of one — normally lethal in Close Quarters.

**Fix.** Stamp the window when it is spent, on the activation rather than the operative: set `next.opState['guardInterruptUsedFor'] = next.activeOperativeId` inside the OnGuardInterrupt case, have offerGuardInterrupt return early when it is already set for the current activeOperativeId, and have the case itself fail with 'the On Guard window for this activation has already been used'. Clear it in ActivateOperative and Counteract. Also require a live opState.guardOffer naming that operative, so the interrupt can only fire in the "after that enemy operative performs an action" window. The reducer, not the UI, must be the gate.

**Risk.** Low. Note killzones.txt:553's "(including actions that are treated as such, e.g. Hatchway Fight)" stays unreachable regardless, because the intent type is literally `action: 'Shoot' | 'Fight'` (src/core/intents.ts:57) — widen it here or file it explicitly.

Files: `src/core/reducer.ts`, `src/ui/command/play.tsx`

Test: tests/rules-review.test.ts quoting killzones.txt:553: two on-guard operatives, an active enemy performing two actions — the first interrupt is accepted, the second (by the other operative, after the enemy's second action) is rejected; and after the enemy's activation ends, a new activation reopens the window.

### W-14 · Hatchway Fight never checks the target is within 2" of, or on the other side of, the access point — it is a 1AP melee attack on anyone on the board

**FIXED** · engine · major

Rules pinned: `killzones.txt:565 ("instead select an enemy operative within 2\" of, and on the other side of, an open hatchway's access point the active operative is touching")`; `killzones.txt:567 ("or if its base isn't touching an open hatchway's access point")`

**Problem.** Verified still open at src/core/actions.ts:416-422. The check verifies the map is Close Quarters, the operative is not engaged, and it is touching an open access point — for the target it does nothing but `if (!params.targetId)`. perform() calls startFight with {hatchway:true}, and fight.ts:56 reads `if (!opts.hatchway && !inControlRange(...))`, so the flag skips the only positional test in the path. Neither the 2" radius nor the 'other side of' half-plane exists. Proved: a target 15" away on the SAME side of the wall was accepted with zero rejections and a full fight started. src/ai/legal.ts filters its own shortlist by gapBetween(op, enemy) <= 2 — a different measurement, operative-to-operative rather than to the access point, and not a legality gate. Separately touchingOpenAccessPoint approximates 'touching' as baseGap to a 20mm disc at the access point's bounding-box CENTRE <= 0.6", which admits an operative ~0.46" clear of the 1.067" square.

**Fix.** Resolve the access point returned by touchingOpenAccessPoint and require of the intended target: (1) baseDistanceToPart(target…, accessPoint) <= 2 + EPS, and (2) that the target is on the opposite side of the access point's plane from the active operative — equivalently that the segment active->target crosses the access-point polygon. Reject with a named reason. Tighten touchingOpenAccessPoint to baseGapToPoly(op, accessPoint.poly) <= 0.

**Risk.** Low. Door Fight (W-30) should reuse whatever helper this introduces.

Files: `src/core/actions.ts`, `src/ai/legal.ts`

Test: tests/rules-review.test.ts quoting killzones.txt:565: three cases against one open access point — a target 1.5" through the doorway (accepted), a target 3" through it (rejected), and a target 1.5" away on the SAME side (rejected). A fourth pins killzones.txt:567 by placing the operative 0.46" clear of the access-point polygon and expecting rejection.

### W-15 · Declining one counteract window burns every counteract for the rest of the turning point

**FIXED** · engine · major

Rules pinned: `core-rules.txt:232 ("Each operative can only counteract once per turning point… Counteracting is optional, so you can choose not to. In either case, activation alternates back to your opponent afterwards")`

**Problem.** Verified still open at src/core/reducer.ts:331: `case 'DeclineCounteract'` does `for (const o of aliveOperatives(next, intent.player)) o.counteractedThisTP = true;` — it marks EVERY one of the declining player's operatives as having already counteracted. That flag is only reset by readyStep at the start of the next turning point, and counteractCandidates filters on !o.counteractedThisTP, so whoActivates never returns mode:'counteract' for that player again. The only per-turning-point budget the rule imposes is per operative and is spent by actually counteracting. A player facing three remaining enemy activations who passes on the first window loses two free 1AP actions they were entitled to. The UI has been written around the bug rather than against it: the button in src/ui/command/play.tsx:176 reads 'Decline — no more counteracts this turning point'.

**Fix.** Drop the loop. Record the declined WINDOW instead — e.g. `next.opState['counteractDeclined'] = { player: intent.player, at: next.activationsThisTP }` — and have whoActivates/counteractCandidates suppress counteract mode only while that stamp matches the current activationsThisTP. EndActivation already increments activationsThisTP for real activations, so the next window reopens by itself. Restore the UI label to 'Not now'.

**Risk.** Low, but it lengthens every turning point in bot play (more windows offered), so soak runtime and any activation-count assertions move.

Files: `src/core/reducer.ts`, `src/core/phases.ts`, `src/ui/command/play.tsx`

Test: tests/rules-review.test.ts quoting core-rules.txt:232: three expended Engage operatives facing three ready enemies — DeclineCounteract, then one enemy activate/end cycle, then whoActivates returns {player, mode:'counteract'} again with all three still candidates; and an operative that actually counteracts is excluded for the rest of the turning point.

### W-16 · "Until the end of the turning point" effects are deleted before the crit op reads marker control at the end of that turning point

**FIXED** · engine · major

Rules pinned: `the-missions.txt:184 ("If friendly operatives control any transmitting objective markers, you score 1VP")`; `core-rules.txt:540 (marker control by total contesting APL)`

**Problem.** Verified still open. src/core/reducer.ts:684-685 calls endTurningPoint(ctx, state) and then ctx.scoreEndOfTurningPoint. endTurningPoint (src/core/phases.ts:201-205) emits onEndOfTP and then expireEffects(state), which drops every effect whose expiry kind is endOfTurningPoint. Marker control is decided by total contesting APL, and APL modifiers reach aplOf through onStatMod hooks that read state.effects — so a ploy bought precisely to win the end-of-turning-point control check is gone a few lines before the check runs. 119 effects across src/ use kind:'endOfTurningPoint'. Corroborated in-tree: src/teams/tempestus-aquilons/index.ts:1371 gives its Drop and Secure marker-control effect endOfBattle expiry with a comment naming this exact ordering as the reason.

**Fix.** Split endTurningPoint so the expiry sweep runs after scoring: emit onEndOfTP, call ctx.scoreEndOfTurningPoint, then expireEffects(state). In advanceTurningPoint that is a two-line reorder. Then change the Tempestus Aquilons workaround back to the expiry the card actually prints.

**Risk.** Low mechanically; it silently changes the scoring of Secure, Orb, Stake Claim, Energy Cells, Download and Reboot in any game where such an effect exists, so re-baseline the ops tests deliberately. Note removeIncapacitated also runs inside endTurningPoint — confirm the reorder does not let a dying carrier score.

Files: `src/core/phases.ts`, `src/core/reducer.ts`, `src/teams/tempestus-aquilons/index.ts`

Test: tests/ops.test.ts quoting the-missions.txt:184: with crit op Transmission and both players contesting a transmitting marker at APL 2 each, an effect giving +1 APL with expiry {kind:'endOfTurningPoint'} is still present when scoreEndOfTurningPoint runs, and the player scores 2VP. A second assertion that the effect IS gone once the next turning point begins.

### W-17 · Melee Devastating fires only for criticals actually used to strike, and ignores the distance-prefixed form entirely

**FIXED** · engine · major

Rules pinned: `appendix.txt:188 ("Each retained critical success immediately inflicts x damage… Note that success isn't discarded after doing so — it can still be resolved later in the sequence")`

**Problem.** Verified still open at src/core/sequences/fight.ts:487-490: Devastating is applied inside the `mode === 'strike'` branch of resolveFightDie, so a retained critical that the opponent blocks, or that its owner spends as a block, or that is never resolved because the fight short-circuits on an incapacitation, pays nothing. dev.radius is never read in fight.ts, so `x" Devastating y` inflicts nothing on nearby operatives in melee. The in-file comment even admits the timing is wrong ("inflicts on each retained critical success as it is retained; we apply it on the strike so it is visible in the ticker"). The shooting path is now correct — commit 76d4e74 added DieState.blockedFrom and resolveAttackDice counts retained crits before blocking — so this is the melee half of a defect already fixed once.

**Fix.** Move Devastating out of resolveFightDie and into the end of the Fight sequence's 'retention' step, mirroring resolveAttackDice: per side, countCrits(pool) after retention settles, inflictDamage(dev.perCrit * retainedCrits) on the opposing fighter, and when dev.radius !== undefined also on every operative visible to and within that distance. Leave the dice in the pool so they can still be struck or blocked, and run it before the strike/block alternation and before the incapacitation short-circuit. applyStun (added in the working tree at fight.ts:423) already runs at exactly that point and is the insertion site.

**Risk.** Low, and it pairs naturally with the melee Stun work already sitting uncommitted in fight.ts — same function, same rule shape. Land on top of that diff, not beside it.

Files: `src/core/sequences/fight.ts`

Test: tests/rules-review.test.ts quoting appendix.txt:188: a Devastating 3 melee weapon retains two criticals and their owner resolves BOTH as blocks — 6 damage is still inflicted. A second case with `2" Devastating 1` splashing a third operative within 2" of the defender. A third where the attacker is incapacitated before resolving its second critical.

### W-18 · A Charge may clip a lone enemy's control range and finish on a different enemy — `stickyEngagedWith` is written and read nowhere

**OPEN** · engine · major

Rules pinned: `core-rules.txt:285 ("If it moves within control range of an enemy operative that no other friendly operatives are within control range of, it cannot leave that operative's control range")`

**Problem.** Still open after the path-sampling work landed in 4e78620. enemyOnTheWay now samples every leg, but for a Charge opts.mayEnterEnemyControlRange is true so it `continue`s past the control-range branch without recording WHICH enemies were entered. actions.ts:252 then computes op.stickyEngagedWith from the enemies in control range AT THE END of the move, so an enemy clipped mid-path is never recorded, and grep confirms stickyEngagedWith is read by no file in src/core (src/teams/gellerpox-infected/index.ts:205 documents this in a comment). So a charger routes past an unscreened bodyguard straight onto the leader, and every team rule that would lift the sticky restriction lifts nothing.

**Fix.** While sampling the Charge path, collect every enemy whose control range the path enters and for which no friendly operative was already within that enemy's control range at the start of the action — enemyOnTheWay already computes exactly that `screened` map, so return the set instead of discarding it. Require the final position to be within the control range of each such enemy, failing with 'a Charge cannot leave the control range of an operative it moved within'. Populate op.stickyEngagedWith from that path-derived set and read it in later move validation so the teams' exemptions become meaningful.

**Risk.** Medium: it further narrows legal Charges, so src/ai/moves.ts must route around unscreened enemies or soak games gain rejected intents. It is also the natural place to make KNOWN-1's multi-waypoint routing charge-aware — coordinate with whoever holds that work.

Files: `src/core/movement.ts`, `src/core/actions.ts`, `src/ai/moves.ts`

Test: tests/rules-review.test.ts quoting core-rules.txt:285: charger at (10,11), unscreened enemy A at (12,13), target B at (16.5,11) — a Charge to B's control range that passes within 1" of A is rejected; the same Charge is accepted once a friendly operative is already within A's control range; and a Charge that finishes on A records stickyEngagedWith [A].

### W-19 · The Accessible +1" is charged for every increment that merely starts or ends on Accessible terrain, and only once when two parts are crossed

**FIXED** · engine · major

Rules pinned: `killzones.txt:222 ("Operatives can move through Accessible terrain… but it counts as an additional 1\" to do so")`

**Problem.** Verified still open. accessibleCrossings (src/core/terrain.ts:244) uses segmentCrossesPoly, whose first line is `if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true`. Bheta-Decima gantry floors are typed ['Accessible','Vantage','Light'] at z0=z1=3.0, so an operative standing on a gantry is permanently inside an Accessible polygon and pays +1" on every increment it makes up there: a 5" walk along gantry C is charged 6" and consumes a whole Move, and a 3" Dash along it is rejected as 'move of 4" exceeds the 3" budget'. The same applies to the condenser roof and to anyone standing in an open hatchway. Separately src/core/movement.ts:193 charges a flat `access.length > 0 ? 1 : 0`, so crossing two distinct Accessible parts in one increment costs +1" instead of +2". Note the sibling instance of this same geometry defect in interveningParts was fixed in e6c3181 by an `underfoot` skip-set — this one was not.

**Fix.** Give accessibleCrossings a genuine passes-through test rather than segmentCrossesPoly: a part counts only when the segment actually crosses its boundary (an edge intersection), so a segment wholly inside one Accessible part is no crossing. Then charge `extra = accessCount + obstructingCount` so two crossings cost +2". Consider exporting the strict predicate from geometry.ts — W-22 needs the same shape for Obstructing.

**Risk.** Low-medium: it makes moves cheaper, so reachableCells grows and AI move evaluation shifts on all six Bheta-Decima maps. Do not change segmentCrossesPoly itself — it has 15 callers across team modules that depend on the permissive endpoint behaviour.

Files: `src/core/terrain.ts`, `src/core/movement.ts`, `src/core/geometry.ts`

Test: tests/rules-review.test.ts quoting killzones.txt:222, loading the real data/maps/bheta-decima/bheta-decima-1.json: a 5" walk between two points both on gantry C is charged 5", a 3" Dash along it is accepted, a move that steps onto the gantry from the floor is charged +1", and a single increment crossing two distinct Accessible parts is charged +2".

### W-20 · Vertical movement is unvalidated: `path.endZ` teleports for free, and a jump to a feature 1" higher is charged as a 2" climb and banned during a Dash

**FIXED** · engine · major

Rules pinned: `killzones.txt:163 ("within 1\" horizontally and 3\" vertically… Each climb is treated as a minimum of 2\" vertically")`; `killzones.txt:172 ("When jumping to a terrain feature, you can ignore its height difference of 1\" or less, including its rampart")`; `core-rules.txt:269 (Dash: "it cannot climb during this move, but it can drop and jump")`

**Problem.** Two still-open defects in the same 40-line branch of validateMove. (a) src/core/movement.ts:249 `const finalZ = path.endZ ?? curZ;` takes the caller's declared elevation after the per-leg loop has finished, so the difference costs nothing, is never tested against the 3" ceiling or the 1" horizontal-proximity rule, and is not blocked by opts.noClimb — only canStandAt is applied. Proved: Reposition with {points:[{x:12.5,y:11}], endZ:3} charges 1" for a 3" ascent, and the same as a Dash is accepted; a 6" descent via endZ:0 charges 1" instead of 5". Intermediate path.zs entries are likewise never checked against a real surface. (b) In the dz>0 branch, isJumpLanding is consulted only to bypass the 1"-horizontal guard at line 148 — line 150 still charges Math.max(2, dz), so the height difference the rule says to IGNORE costs 2", and the `if (opts.noClimb) return fail` at line 145 runs first, so a Dash is rejected with 'Dash cannot climb' for exactly the landing the rules permit. Live on Volkus, whose stronghold Vantage levels sit at 3.0 and 3.5. (The downward jump case at line 168 is already handled correctly.)

**Fix.** (a) Fold path.endZ into the loop as the declared z of the final waypoint so the last increment runs through the same climb/drop branch and is charged — or reject any path whose endZ differs from the elevation the legs actually reached. Validate every path.zs entry against a real surface. (b) Hoist isJumpLanding above the noClimb guard into its own branch: set curZ = targetZ, push a zero-charge leg kind 'jump' noted 'height difference ignored', skip the climb charge, and do not consume dropIgnoreLeft; then let the horizontal handler charge the single <=4" jump increment. Enforce the rampart clause on the take-off side rather than ignoring it.

**Risk.** Low today (neither the UI nor the AI emits endZ) but the reducer is the only gate on intents, so replay files and future clients get free vertical movement. The jump half changes charged distances on Volkus, so re-check any movement test using the 3.0/3.5 levels.

Files: `src/core/movement.ts`, `src/core/intents.ts`

Test: tests/rules-review.test.ts with two describes. Quoting killzones.txt:163: a Reposition declaring endZ 3" above the reached elevation is rejected (or charged a full climb), and the same as a Dash is rejected as a climb. Quoting killzones.txt:172: two Vantage platforms at z=4.0 and z=5.0 with a 4" gap — the jump costs 4" total, is legal for a Move 4" operative, and is legal as a Dash.

### W-21 · The retaliating operative still cannot choose among its melee weapons — 64 of 454 datacards are locked to card order

**OPEN** · engine · major · **needs an owner decision**

Rules pinned: `core-rules.txt:377 ("Both players select one melee weapon to use that their operative has and collect their attack dice")`

**Problem.** Half fixed, half open. Commit 76d4e74 made resolution type-aware — startFight now sets seq.defenderProfile from meleeProfileOf(dw) and sideWeapon falls back to `w.profiles.find(p => p.type === 'melee')` — so the 15 weapons ordered ranged-first no longer retaliate with a ranged profile. What remains is the choice itself: startFight still hard-picks `weaponsOf(ctx, state, defender, 'melee')[0]`, no code anywhere writes seq.defenderWeapon, and there is no decision kind for choosing a retaliation weapon, so the comment at fight.ts:60 ("the AI/UI may override the choice via a decision") still describes a mechanism that does not exist. A Blooded Traitor Chieftain always retaliates with its Bayonet (Atk 3, Dmg 2/3) and can never use its Power weapon (Atk 4, Dmg 4/6, Lethal 5+).

**Fix.** Add a `selectRetaliationWeapon` PendingDecision emitted at a new 'selectWeapons' step whenever the defender has more than one melee weapon or profile available, resolved before 'rollAttack'. The reactive-window machinery already supports blocking the reducer on a defender-owned decision (this is exactly the shape of cover-vs-obscured). Give the AI a defaultDecisionOption that picks the highest expected damage, and the UI a branch in commandPlan.

**Risk.** Medium: a new blocking decision in every fight against a multi-melee-weapon operative changes decision counts in every AI game and adds a screen to the UI flow. Cheap interim if the owner prefers: default to the highest-Atk melee profile and file the decision separately.

Files: `src/core/sequences/fight.ts`, `src/core/decisions.ts`, `src/core/sequences/types.ts`, `src/ai/legal.ts`, `src/ui/command/play.tsx`

Test: tests/rules-review.test.ts quoting core-rules.txt:377 against the real data/teams/blooded.json Traitor Chieftain: startFight raises a decision with kind 'selectRetaliationWeapon' whose options include both the Bayonet and the Power weapon, and resolving it to the Power weapon gives the defender Atk 4 / Dmg 4/6.

### W-22 · Razor wire is built as solid terrain, so the Obstructing +1" is computed and then thrown away and the wire cannot be crossed at all

**OPEN** · engine · major

Rules pinned: `universal-equipment.txt:100 ("Razor wire is Exposed and Obstructing terrain"; "Whenever an operative would cross over this terrain feature within 1\" of it, treat the distance as an additional 1\"")`

**Problem.** Verified still open at src/core/equipment/kit.ts:145: buildEquipmentFeature sets `solid: !insignificant`, and razor wire's types are ['Exposed','Obstructing'], so the part is solid with z0=0, z1=1.42". In validateMove the +1" Obstructing charge is computed at line 192 and pushed onto the leg — and three statements later the same segment is handed to pathBlockedByTerrain, which iterates index.solid and skips only Accessible, Insignificant and Ceiling, so the wire is returned and the move is rejected as 'cannot move through equipment (Exposed+Obstructing)'. The toll is unreachable on any horizontal move and a 2.8"-wide piece of equipment behaves as an impassable wall for the whole battle. The 'within 1" of it' clause is also absent: obstructingCrossings only charges when the segment literally crosses the polygon.

**Fix.** Give Obstructing parts `solid: false` in buildEquipmentFeature (or add `if (hasType(part,'Obstructing')) continue;` to pathBlockedByTerrain next to the Insignificant skip), so crossing is legal and the already-correct +1" applies. Then widen obstructingCrossings from segmentCrossesPoly to 'crosses the polygon inflated by 1"' to implement the within-1" clause.

**Risk.** Low. The within-1" inflation is the judgement-sensitive half — polygon inflation on a thin rectangle is fiddly; a Minkowski-style expand or a baseGapToPoly <= 1 test on the segment samples both work, and the choice should be recorded in docs/DECISIONS.md.

Files: `src/core/equipment/kit.ts`, `src/core/terrain.ts`

Test: tests/equipment.test.ts quoting universal-equipment.txt:100: a 4" Reposition straight across razor wire is ACCEPTED and charged 5"; a 4" move that passes within 1" of the wire without crossing it is also charged 5"; a 4" move 2" clear of it is charged 4".

### W-23 · The portable barricade gives cover to anyone behind it — the "only while an operative is connected to it" gate is never implemented

**OPEN** · engine · major

Rules pinned: `universal-equipment.txt:142 ("Portable: This terrain feature only provides cover while an operative is connected to it and if the shield is intervening (ignore its feet)")`

**Problem.** Verified still open. The shield is built with types ['Light','Protective','Portable'] and is otherwise an ordinary cover-giving part. `grep -rn "'Portable'" src/` returns exactly two hits: the assignment at src/core/equipment/portableBarricade.ts:36 and the union member in types.ts — nothing reads it. coverAndObscured therefore grants cover for any intervening part within 1" of the target with no connection test. connectedBarricade() exists and gates the MOVE WITH BARRICADE action but is never consulted by the cover code. Proved: with connectedBarricade(...) === undefined, coverAndObscured returned inCover:true with the barricade body as the cover part — a free cover save, and for a Conceal operative an outright immunity to being targeted, from a barricade it is not touching. An enemy walking up behind your barricade claims it too. The Protective save bonus hook is separately loose: it fires on any ev.ctx.inCover from any terrain plus a 1.5" centroid proximity test.

**Fix.** Add a CoverOpts predicate (or an early continue in the coverParts loop of coverAndObscured) that skips any part whose feature is Portable unless the target's base is within CONNECTED_INCHES of that feature's shield polygon, reusing connectedBarricade's geometry. Narrow the Protective hook to fire only when that same feature appears in cover.coverParts.

**Risk.** Low. CoverOpts already carries four predicates after e6c3181, so the shape is established.

Files: `src/core/equipment/portableBarricade.ts`, `src/core/visibility.ts`

Test: tests/equipment.test.ts quoting universal-equipment.txt:142: an operative 1" behind the shield (connectedBarricade undefined) gets inCover:false and, with a Conceal order, is a valid target; the same operative connected to it gets inCover:true and the Protective save bonus; an ENEMY operative connected to it gets nothing.

### W-24 · Smoke's Piercing softening adds a defence die unconditionally, so Piercing Crits 2 into smoke always faces 4 dice

**OPEN** · engine · major

Rules pinned: `universal-equipment.txt:158 ("weapons with the Piercing 2 or Piercing Crits 2 weapon rule have the Piercing 1 or Piercing Crits 1 weapon rule (respectively) instead")`; `appendix.txt:212 ("If the rule is Piercing Crits x, this only comes into effect if you retain any critical successes")`

**Problem.** Verified still open at src/core/equipment/grenades.ts:215-232. The onDefenceDice hook models 'Piercing 2 -> Piercing 1' as `ev.count += 1` whenever the weapon carries Piercing or PiercingCrits with x >= 2. But the base count is `3 - piercingValue(rules, retainedCrits)`, and piercingValue returns 0 for PiercingCrits when no critical was retained — so when PiercingCrits contributed nothing the hook still hands the defender a FOURTH die. This is not an edge case: a target wholly in smoke is obscured, and the obscured step converts every retained critical to a normal before rollDefence, so retainedCrits is essentially always 0 for a shot into smoke. Proved: 'no crits, no smoke' rolls 3 dice; 'no crits, in smoke' rolls 4. Two further bugs in the same hook: it tests `dist(m.pos, target.pos) <= 1` rather than the whollyWithinSmoke selector the obscured half of the same rule uses, and a `target.player !== b.player` guard disables the softening whenever the smoke-throwing player is the one shooting into their own smoke.

**Fix.** Cap the adjustment at what Piercing actually removed: expose the sequence's effective piercingValue(rules, retainedCrits) on the AttackContext and do `ev.count += Math.min(1, effectivePiercing)`. Replace the 1" distance test with whollyWithinSmoke(body(ctx,target), smokeAreas(state)), and drop the owner guard.

**Risk.** Low. Requires adding one field to AttackContext, which is a typed hook payload — an unknown field is a build error, so the change is self-checking.

Files: `src/core/equipment/grenades.ts`, `src/core/sequences/shoot.ts`, `src/core/hooks.ts`

Test: tests/equipment.test.ts quoting universal-equipment.txt:158: a Piercing Crits 2 weapon shooting a target wholly in smoke 6" away with no retained crit collects 3 defence dice, and with a retained crit collects 2. A third case with the shooter owning the smoke, asserting the softening still applies.

### W-25 · Kill grade is a one-way ratchet — a REANIMATED operative never lowers the opponent's grade or takes back the VP

**OPEN** · engine · major

Rules pinned: `approved-ops-2025.txt:419 ("As REANIMATED operatives are no longer incapacitated… your opponent's kill grade can go down during the battle (they lose VP accordingly)")`

**Problem.** Verified still open at src/core/ops/killOp.ts:31-37. updateKillGrade recomputes the correct grade from incapacitatedEnemies — which does drop back when op.incapacitated/op.removed are cleared — but then only ever raises it: `while (team.killGrade < grade) { team.killGrade += 1; awardVP(...) }`. There is no branch that lowers team.killGrade and no path that removes previously awarded VP from vpByOp/team.vp. HIEROTEK CIRCLE reanimate() clears both flags exactly as the rule describes, so the count drops while the grade and VP do not — and killGrade is also the value compared for the end-of-battle 'kill grade higher than your opponent's' 1VP, so a player can win that on a grade they no longer hold. Worth up to 2VP a game against a reanimating team.

**Fix.** Make updateKillGrade two-way: when grade < team.killGrade, step down and remove 1VP per grade lost from vpByOp[KILL_OP_ID] and team.vp — a revokeVP counterpart to awardVP, logged as a score line. Leave every other op's slots untouched, per the rule's "won't retroactively change any other VPs" clause.

**Risk.** Low, but revokeVP is a new primitive interacting with the 6VP-per-op cap and its per-turning-point slot array. Make sure revoking then re-earning does not let a team exceed the cap.

Files: `src/core/ops/killOp.ts`, `src/core/ops/common.ts`

Test: tests/ops.test.ts quoting approved-ops-2025.txt:419: two kills give grade 2 / 2VP; clearing incapacitated+removed on one victim (what reanimate() does) and re-running updateKillGrade gives grade 1 / 1VP; and a tac op's VP scored in the same turning point is unchanged.

### W-26 · The kill grade row is recomputed from the live roster, so operatives added mid-battle push the enemy onto a harder row

**OPEN** · engine · major

Rules pinned: `approved-ops-2025.txt:267 ("The row you use is determined by the starting number of enemy operatives")`

**Problem.** Verified still open at src/core/ops/common.ts:356: killOpStartingSize returns `state.teams[player].operativeIds.length` (minus ignored operatives) evaluated at scoring time. TeamState.startingSize — set once at SelectRoster in src/core/reducer.ts:135, and therefore the actual starting number — is never read by the kill op. Rules that push new operatives onto team.operativeIds mid-battle (CANOPTEK CIRCLE 'A Ceaseless Scuttling', a STRATEGIC GAMBIT usable every turning point after the first) change the row the opponent's grade is read from part-way through the battle: a 6-operative team grown to 9 turns row 6 [1,2,4,5,6] into row 9 [2,4,5,7,9], costing the opponent a VP at four kills and potentially the end-of-battle comparison too. The GELLERPOX INFECTED MUTOID VERMIN clause relies on team.startingSize being left alone — a field the kill op does not consult.

**Fix.** Derive killOpStartingSize from state.teams[player].startingSize, subtracting only those STARTING operatives that are ignored for the kill op. Keep incapacitatedEnemies scanning the live roster so a mid-battle addition that is later incapacitated still counts as a kill.

**Risk.** Low. Confirm startingSize is recorded for both players in every entry path (SelectRoster is the only writer today) and that operatives ignored for the kill op are subtracted from the snapshot rather than the live list.

Files: `src/core/ops/common.ts`, `src/core/ops/killOp.ts`

Test: tests/ops.test.ts quoting approved-ops-2025.txt:267: a 6-operative team grown to 9 mid-battle, with 4 of its operatives incapacitated — the opponent's kill grade is 3 (row 6), not 2 (row 9).

### W-27 · Reboot can be performed while within control range of an enemy operative

**FIXED** · engine · major

Rules pinned: `the-missions.txt:154 ("An operative cannot perform this action during the first turning point, or while within control range of an enemy operative")`

**Problem.** Verified still open at src/core/ops/crit/reboot.ts:93: the check hand-rolls only the turning-point half (`if (state.turningPoint < 2) …`) and then goes straight to the marker checks. It is the one crit-op mission action that does not call missionActionCheck (src/core/ops/common.ts:425), which is where the shared 'within control range of an enemy operative' guard lives — Secure, Loot, Initiate Transmission, Move Orb, Download, Compile Data and Send Data all call it. Proved: an operative with an enemy 0.9" away performed Reboot and the identical setup under Secure was correctly rejected. Up to 3VP across TP2-4, and it removes the entire counterplay of charging an operative to lock down the marker.

**Fix.** Replace the inline turning-point test with `const guard = missionActionCheck(ctx, state, op); if (!guard.ok) return guard;`, exactly as src/core/ops/crit/secure.ts:31 does.

**Risk.** None material. The smallest item in the plan — a one-line change.

Files: `src/core/ops/crit/reboot.ts`

Test: tests/ops.test.ts quoting the-missions.txt:154: with crit op Reboot in turning point 2, an operative controlling the inert marker with an enemy inside its control range is rejected with 'within control range of an enemy operative', and the same operative with the enemy 2" away succeeds.

### W-28 · Breach performs no control-range check and its concussion roll hits operatives on the breacher's own side of the wall

**OPEN** · engine · major

Rules pinned: `killzones.txt:517 ("Open a closed breach point thats access point is within the operative's control range")`; `killzones.txt:521 ("Roll one D6 separately for each operative that's on the other side of the access point and has that access point within its control range")`

**Problem.** Verified still open at src/core/actions.ts:493-520. The check tests only that the operative is not in an enemy's control range, that params.partId names a role:'accessPoint' part, and that it is not already open — unlike Operate Hatch (actions.ts:461), it never measures the distance from the operative to the access point, so any closed breach point on the board can be opened from any range. The concussion loop then iterates aliveOperatives(state), skips only the breacher, and rolls a D6 for every operative whose base gap to the access point's bounding-box CENTRE is <= 1", with no test of which side of the wall they are on — so the breacher's own squadmates take D6-halved damage and -1 APL. The printed "cannot perform this action for less than 2AP during an activation in which it performed the Charge or Shoot action" clause (killzones.txt:523) exists only as a comment at actions.ts:499-500.

**Fix.** Add the control-range test Operate Hatch already has. Filter the concussion loop to operatives on the OTHER side of the access point — the same half-plane / segment-crosses-the-access-point test W-14 introduces for Hatchway Fight — and require the access point to be within each victim's control range rather than 1" of its bounding-box centre. Implement the 2AP clause while in the file.

**Risk.** Low, and it should reuse W-14's side-of-the-access-point helper — sequence them or duplicate the geometry.

Files: `src/core/actions.ts`

Test: tests/rules-review.test.ts quoting killzones.txt:517 and :521: Breach from 5" away is rejected; from within 1" it succeeds; and with one friendly on the breacher's side and one enemy on the far side, exactly one concussion D6 is rolled, against the enemy.

### W-29 · Volkus has no killzone module: Garrisoned Stronghold and Condensed Stronghold are entirely unimplemented

**OPEN** · engine · major · **needs an owner decision**

Rules pinned: `killzones.txt:383 (Garrisoned Stronghold: "the defender resolves first (this takes precedence over the normal fight resolution order)")`; `killzones.txt:378 (Condensed Stronghold: Blast/Torrent/x\" Devastating "also has the Lethal 5+ weapon rule if the target is wholly within a stronghold terrain feature and on the killzone floor or a fire step")`

**Problem.** Verified still open. `grep -rl volkus src/` returns only visibility.ts (controlRangeIgnores) and types.ts — there is no Volkus killzone module. startFight hard-codes turn:'attacker' and nothing flips it for a stronghold, though ten team modules already do `seq.turn = 'defender'` from a hook, so the mechanism exists and is simply not wired. effectiveRules applies condensedEnvironmentRules only when state.map.closeQuarters is true, and all six Volkus maps ship closeQuarters:false (correctly, per D-002) — Condensed STRONGHOLD is a distinct Cityfight rule that appears nowhere in src/. Reproduced on the real volkus-1 map: a defender wholly inside Stronghold B's wall ring with the attacker outside gets turn = 'attacker', and a Blast 2" weapon fired at a floor-level target inside Stronghold B gains no Lethal.

**Fix.** Create a Volkus killzone module registering two hooks: one that sets seq.turn = 'defender' when the fight's defender is wholly within a volkus.strongholdA/B feature and the attacker is not, and an onWeaponRules handler appending {id:'Lethal', x:5} when the map is volkus, the profile has Blast / Torrent / Devastating-with-a-distance, and THIS resolution's target is wholly within a stronghold and standing at z=0 or on a fire step. Reuse the guard in weaponRules.ts so it does not downgrade an existing Lethal, and apply per-target so Blast/Torrent secondaries outside the stronghold are unaffected. Both need a new `whollyWithinFeature(index, body, kinds)` selector in src/core/terrain.ts.

**Risk.** Medium and gated on W-04: 'wholly within a stronghold' is only meaningful once the wall ring is a per-level band with a real interior, and 'or a fire step' cannot be evaluated until W-04 extracts key C. There is also no killzone-module registry today — creating one is a small architectural addition worth agreeing first.

Files: `src/core/terrain.ts`, `src/core/killzones/volkus.ts`, `src/core/sequences/fight.ts`, `src/core/weaponRules.ts`, `docs/RULES-COVERAGE.md`

Test: tests/rules-review.test.ts quoting both rules, on the real volkus-1 map: a defender at (6.4,5.0) wholly inside Stronghold B with the attacker at (7.1,5.0) outside gets seq.turn = 'defender', and effectiveRules for a Blast 2" weapon against a floor-level target inside the stronghold includes Lethal 5+ while the same weapon against a target outside does not.

### W-30 · The DOOR FIGHT universal action does not exist, so one operative in a doorway seals every building on Volkus

**OPEN** · engine · major

Rules pinned: `killzones.txt:388-391 ("DOOR FIGHT 1AP… instead select an enemy operative on the killzone floor and within 2\" of, and on the other side of, a door the active operative is touching. For the duration of that action, those operatives are treated as being within each other's control range")`

**Problem.** Verified still open. registerAction declares exactly twelve actions and 'Door Fight' appears nowhere in src/, tests/ or docs/RULES-COVERAGE.md. Its identically-worded Close Quarters twin, Hatchway Fight, is fully implemented at src/core/actions.ts:407 with a touchingOpenAccessPoint helper and a {hatchway:true} flag through startFight — but it is gated on state.map.closeQuarters, which is false on all six Volkus maps. So an enemy parked in a stronghold or large-ruin doorway cannot be attacked in melee at all: Fight requires real control range, which the Accessible+Heavy door denies across the doorway, and Hatchway Fight refuses as 'a Close Quarters action'. A single defender permanently seals every building, the exact situation the rule was printed to prevent. Now newly reachable in practice, since the Volkus doors themselves landed in 3d22ad2.

**Fix.** Register a 'Door Fight' action mirroring Hatchway Fight: 1AP, type 'universal', treatedAs 'Fight', `available: (_ctx, state) => state.map.killzone === 'volkus'`, a touchingDoor helper matching role:'door' parts on volkus.strongholdA/B and volkus.largeRuin at baseGap <= 0, plus the two extra clauses the hatchway version does not need — the target must be on the killzone floor and within 2" — reusing startFight's existing control-range bypass flag and W-14's side-of-the-part test.

**Risk.** Low, and mostly duplication of W-14 — do them together or immediately after each other so the 2"-and-other-side helper is written once.

Files: `src/core/actions.ts`, `src/ai/legal.ts`, `docs/RULES-COVERAGE.md`

Test: tests/rules-review.test.ts quoting killzones.txt:388, on the real volkus-1 map: an operative touching Stronghold A's door fights an enemy 1.5" through it on the killzone floor (accepted, fight starts); the same enemy on the operative's own side is rejected; an enemy on the stronghold's Vantage level is rejected.

### W-31 · Stronghold B's highest level accepts any number of operatives — `maxOperatives` is data-only

**OPEN** · engine · major

Rules pinned: `killzones.txt:264 ("You cannot have more than one friendly operative on the highest upper level of Stronghold B at once, and that operative must be placed on one side or the other of that level… This takes precedence over the rules for bases and being in a location it can be placed")`

**Problem.** Verified still open. tools/maps/terrain.py:166 stamps maxOperatives:1 onto Stronghold B's z=6.0 floor part and it is present in all six shipped maps, but `grep -rn maxOperatives src/` returns nothing. validateMove's end-of-move checks are terrain solidity, Vantage standability, base overlap and control range; canDeployAt checks drop zone, hazardous and base overlap. Neither consults the part an operative ends on for an occupancy cap, and neither implements the 'one side or the other, not the middle' clause. Reproduced: a second friendly's move onto the 2.04" x 2.15" top plate was accepted at endZ 6. That level is the highest Vantage in the killzone, so it becomes an uncontestable gun nest.

**Fix.** Have validateMove's final-position check and canDeployAt read maxOperatives off the standable part the operative ends on — partsSupporting(index, endPos, endZ) — and reject when the count of friendly operatives already supported by that part reaches it, rejected into state.rejected with the rule text per the intent contract. The 'one side, not the middle' half needs a second annotation on the part (two side sub-polygons) from tools/maps/terrain.py before it can be enforced; file that with W-04 rather than guessing here.

**Risk.** Low. Note the cap is per player — an enemy may share the level — which is easy to get wrong. The side-placement half is deferred and should be recorded as such.

Files: `src/core/movement.ts`, `src/core/reducer.ts`, `src/core/terrain.ts`, `src/core/types.ts`

Test: tests/rules-review.test.ts quoting killzones.txt:264, on the real volkus-1 map: with one friendly on volkus-1.B.p7, a second friendly's Reposition finishing on that part is rejected; an ENEMY operative finishing there is accepted (the cap is on friendly operatives).

### W-32 · Bheta-Decima Restricted Targeting is unimplemented, and with no gantry pillars in the data the killzone has one Heavy part in total

**OPEN** · mixed · major · **needs an owner decision**

Rules pinned: `killzones.txt:594-596 (Restricted Targeting: 4\" of hazardous area between floor-level operatives; a gantry's footprint between a Vantage and a floor operative)`; `killzones.txt:578 ("Gantry pillars are Heavy terrain")`

**Problem.** Verified still open on both halves. checkTarget applies Range, the friendly-control-range block, visibility, cover/obscured, Vantage Accurate and the Conceal denial, then returns valid — it never reads index.hazardous and has no notion of a gantry footprint; grep for 'hazard' across visibility.ts and src/core/sequences/ returns nothing. And the map data models a gantry as a single zero-thickness floor part with types [Accessible,Vantage,Light] and no pillars: buildTerrainIndex on bheta-decima-1 yields 11 parts of which exactly one is Heavy (the condenser body), so obscured is unreachable anywhere except beside that one building and nobody under or behind a gantry ever gets a Heavy cover save. Reproduced: a shot with 13.2" of hazardous ocean on the line returned valid:true. Bheta-Decima plays as an almost completely open board, inverting the killzone's design. docs/RULES-COVERAGE.md:102 marks both rows as covered, which is misleading.

**Fix.** Two halves, ideally one person. ENGINE: add a killzone hook into checkTarget after the visibility test using targetingLines(a,t) — reject when both bodies are at z~0 and the lines' total intersection with index.hazardous is >= 4", and reject when exactly one body is on Vantage and a line crosses the 2D footprint of a gantry feature, excluding features (and, per killzones.txt:579, groupIds) either body is standing on or under. DATA: emit gantry pillar parts as Heavy in tools/maps/extract_cards.py, or record them in data/terrain/bheta-decima.json with provenance + confidence and place them at the gantry ends. Correct the two docs/RULES-COVERAGE.md rows.

**Risk.** Medium, and it is the only mixed engine+data item. The pillar positions are a judgement call with no printed coordinates — they need provenance + confidence like every other extracted height. Turning Restricted Targeting on materially shrinks what the AI may shoot, so re-run the soak.

Files: `src/core/sequences/shoot.ts`, `src/core/visibility.ts`, `tools/maps/extract_cards.py`, `data/terrain/bheta-decima.json`, `docs/RULES-COVERAGE.md`

Test: tests/rules-review.test.ts quoting killzones.txt:594, on the real bheta-decima-1 map: a floor-to-floor shot from (16,19) to (21,6) across the ocean returns valid:false; a floor-to-floor shot with under 4" of hazardous between them stays valid; a Vantage-to-floor shot through a gantry footprint is invalid while one through the gantry the shooter is standing ON is valid. Plus a data assertion that every gantry feature owns at least one Heavy pillar part.

### W-33 · Tomb World teleport pads are inert scenery, and the mutual-control-range clause is dead code written backwards

**OPEN** · engine · major

Rules pinned: `killzones.txt:528 ("From the start of the second turning point, whenever a friendly operative on a teleport pad performs the Charge, Fall Back or Reposition action, you can teleport it… remove it from the killzone and set it back up on the other teleport pad")`; `killzones.txt:526 (pad restrictions)`

**Problem.** Verified still open. OperativeState.onTeleportPadId is declared in types.ts:318 and read in exactly one place — src/core/state.ts:149, `if (a.onTeleportPadId && b.onTeleportPadId && a.onTeleportPadId === b.onTeleportPadId) return true;` — and is assigned NOWHERE in src/, so the field is permanently undefined and the branch is dead. It is also the wrong condition: the rule is one operative ON the pad and another merely TOUCHING it, whereas the code requires both to be on the same pad, which the one-operative limit forbids. There is no teleport action, no teleport variant of Reposition/Charge/Fall Back and no teleport branch in movement.ts, and nothing enforces the one-operative limit, the 'not on the killzone floor' clause or the 2" equipment exclusion. Given W-01, teleport is also the only mechanism that could move an operative between halves of a Tomb World board.

**Fix.** Set op.onTeleportPadId after every position change when the base is inside a role:'teleportPad' part (settleZ is the natural home), and rewrite state.ts:149 as 'a is on a pad AND b's base touches that same pad, or vice versa'. Add a MoveOptions flag `teleport` handled by Reposition/Charge/Fall Back: when set, state.turningPoint >= 2 and the operative is on a pad, place it on the other pad (swapping any occupant), run the action's own end-of-move requirements against the new position, and stamp a once-per-activation marker. Block a second operative from finishing a move on an occupied pad, and reject equipment placement within 2" of a pad.

**Risk.** Medium — 'remove and set up again' is a distinct movement mode with its own end-of-move validation, and the swap case (both pads occupied) needs a decision about ordering. docs/RULES-COVERAGE.md:101 currently claims the control-range half works; correct that row as part of the change.

Files: `src/core/movement.ts`, `src/core/actions.ts`, `src/core/state.ts`, `src/core/equipment/index.ts`, `docs/RULES-COVERAGE.md`

Test: tests/rules-review.test.ts quoting killzones.txt:528, on the real tomb-world-2 map (which has both pads): an operative on T-1 in TP2 performing Reposition with teleport is set up on T-2 and its action's own end-of-move rules are applied; the same in TP1 is rejected; a second operative finishing a move on an occupied pad is rejected; and an operative touching an occupied pad is in mutual control range with its occupant.

### W-34 · A move may finish with two bases fully overlapping — the end-of-move overlap guard is a dead comparison

**OPEN** · engine · major · **needs an owner decision**

Rules pinned: `core-rules.txt:407 ("The sides of different bases can touch, but a base cannot be placed on another")`

**Problem.** Verified still open at src/core/movement.ts:262: `if (baseGap(cur, c.base, rot, other.pos, oc.base, other.rot) < -1e-4)`. baseGap returns Math.max(0, …) on BOTH branches (round and oval, geometry.ts:71-97), so it can never be negative and the guard has never fired. canDeployAt was already fixed to use basesOverlap, so deployment and movement now disagree. Reproduced: a Reposition finishing exactly on a friendly's centre was accepted. The consequence compounds with the marker rules — markerContestedBy counts every operative within 1" of a marker, so a whole fire team can be stacked on one point and every one of them adds APL to the same objective, deciding markerController and therefore primary VP. This is the open owner question already recorded as docs/DECISIONS.md D-050.

**Fix.** Replace the comparison with basesOverlap(...) (already exported from geometry.ts and already used correctly by canDeployAt). Keep the `Math.abs(other.z - finalZ) > 1.0` level guard so operatives on different levels are unaffected. D-050 records that switching this fails sixteen rules tests whose fixtures place models at coincident centres for convenience; nudging those fixtures apart is the correct resolution, not keeping the guard dead — but that is the owner's call, and D-050 lists seven further dead sites in team modules that should be swept in the same change.

**Risk.** The explicit open question in D-050 ("8 dead overlap guards remain, please decide"). Sixteen existing rules tests encode the permissive behaviour and must be re-fixtured; deciding whether those tests or the guard are wrong is a rules question the owner already flagged.

Files: `src/core/movement.ts`, `src/core/geometry.ts`, `docs/DECISIONS.md`

Test: tests/rules-review.test.ts quoting core-rules.txt:407: a Reposition finishing exactly on a friendly's centre is rejected; one finishing with the bases exactly touching (gap 0) is ACCEPTED — the rule permits touching, and a naive overlap predicate that uses <= will break this.

### W-35 · Operative-to-operative distance is horizontal only, so an operative on 3" Vantage terrain is in control range of one on the floor below

**FIXED** · engine · major · **needs an owner decision**

Rules pinned: `core-rules.txt:505 ("When measuring to and from something, do so from the closest part of it. For an operative, do so from its base… When measuring to and from an AREA of the killzone, measure the horizontal distance only")`; `core-rules.txt:410 (control range = "visible to and within 1\"")`

**Problem.** Verified still open. baseGap takes only Vec2 centres and base shapes — z is not a parameter — and every operative-to-operative measurement in the kernel routes through it via gapBetween (src/core/state.ts:139) and withinControlRange (visibility.ts:182): control range, weapon Range x and point-blank, the 2" cover denial, the 1" obscured exemption, smoke, grenades. Two operatives 3" apart vertically and 0.14" apart horizontally measure as 0.14" apart. Reproduced with the repo's own vantagePlatform fixture: inControlRange true, the floor operative may not Shoot ('within control range of an enemy operative') and may not Reposition away, and BOTH may perform Fight — a model on a roof melees a model on the ground. Note the visibility half of this symptom was fixed in e6c3181 (controlRangeIgnores is now scoped to Volkus strongholds and reads height, so a solid floor blocks control range again); what remains is the case with no floor between them, such as stepping off a gantry edge.

**Fix.** Add a z-aware gap — bodyGap(a,b) = hypot(baseGap(...), max(0, |a.z - b.z|)) — and route gapBetween and withinControlRange through it, keeping the pure-2D baseGap for area-of-the-killzone measurements (drop zones, territories, marker-to-polygon). killzones.txt gives Vantage terrain no exemption, so this applies on every map.

**Risk.** The owner should decide the scope. Control range is the case that changes which actions are legal and is unambiguous; whether weapon Range x also becomes 3D is a separate reading (the finding itself flags it) and should be recorded in docs/DECISIONS.md either way. Widening it touches every distance in the kernel, so scope it deliberately and land control range first.

Files: `src/core/state.ts`, `src/core/visibility.ts`, `src/core/geometry.ts`, `docs/DECISIONS.md`

Test: tests/rules-review.test.ts quoting core-rules.txt:505 with the repo's vantagePlatform fixture: an operative at (10.4,11,z=3) and an enemy at (9.0,11,z=0) — horizontal gap 0.14", vertical 3.00" — are NOT in each other's control range, the floor operative may Shoot and may Reposition, and neither may Fight.

### W-36 · An incapacitated operative gets no pre-removal step: granted free actions are dropped and only one carried marker is placed

**OPEN** · engine · major

Rules pinned: `core-rules.txt:423 ("Some rules allow an incapacitated operative to perform a free action before being removed… cannot perform more than one free action (excluding Place Marker)… that operative's player decides the order")`; `core-rules.txt:301 ("If an operative carrying a marker is incapacitated, it must perform this action before being removed… for 0AP")`

**Problem.** Two still-open gaps in the same function. (a) inflictDamage emits onIncapacitated with `{ prevented: false, freeActions: [] }`; only `prevented` is read, and freeActions is read NOWHERE — grep returns the type declaration, the empty initialiser, and comment blocks in ten team modules all saying so. removeIncapacitated then flips removed = true with no opportunity to act. TEMPESTUS AQUILON GUNFIGHTER and its equivalents in Death Korps, Brood Brothers, Wyrmblade, Hearthkyn Salvager and Sanctifiers are meant to fire back when incapacitated; the module comment states the rule is instead approximated as an extra AP on the operative's NEXT activation, which for a removed operative never occurs. (b) removeIncapacitated (src/core/state.ts:346) places exactly one marker — op.carryingMarkerId — so a Steal Intelligence operative carrying two Intelligence markers strands the second on a removed operative, where carriedIntelligence will not score it and Pick Up Intelligence refuses to let anyone recover it.

**Fix.** Give removeIncapacitated a pre-removal step. Iterate EVERY marker whose carriedBy is this operative, place each at its position and clear carriedBy, then clear op.carryingMarkerId — that also makes the early-return at src/core/ops/tac/stealIntelligence.ts:84 harmless rather than load-bearing. Then persist the onIncapacitated freeActions payload (on the operative or in opState) and, when non-empty, raise a PendingDecision { who: operative.player, kind: 'incapacitatedFreeAction', options } before setting removed; resolve it through the existing PerformAction path with ap = 0, allow at most one such action plus Place Marker, and order multiple dying operatives by their own controller's choice rather than by initiative.

**Risk.** Medium-high on half (b): resolving an action for an operative that is incapacitated but not removed is a new reducer state, and it runs inside inflictDamage, which is called from the middle of shoot and fight sequences — re-entrancy needs care. The marker half is trivial; consider landing it first and treating the free-action seam as its own change if the owner wants a smaller step.

Files: `src/core/state.ts`, `src/core/reducer.ts`, `src/core/decisions.ts`, `src/core/hooks.ts`, `src/core/ops/tac/stealIntelligence.ts`

Test: Two tests in tests/rules-review.test.ts. Quoting core-rules.txt:301: an operative carrying two Intelligence markers is incapacitated and BOTH are placed at its position with carriedBy cleared. Quoting core-rules.txt:423: a hook returning freeActions ['Shoot'] on incapacitation raises a decision addressed to the dying operative's player, the free Shoot resolves for 0AP, and the operative is removed afterwards.

### W-37 · Gambit alternation is not enforced by the reducer, and the AI driver lets the initiative player use every gambit first

**OPEN** · engine · minor

Rules pinned: `core-rules.txt:183 ("Starting with the player who has initiative, each player alternates either using a STRATEGIC GAMBIT or passing. The players repeat this process until they have both passed in succession")`

**Problem.** Verified still open. `case 'UseGambit'` validates the gambit id, CP and the per-player once-per-TP list but never checks whose turn it is — src/core/phases.ts:166 admits "The reducer enforces no alternation". The core exports gambitToAct for exactly this and the UI uses it, but actorFor in src/ai/runner.ts:171-178 does not: it returns the initiative player for as long as !state.teams[init].passedGambit, ignoring how many gambits that player has already used. Proved: with p1.gambitsUsedTP = ['g1'] and neither player passed, gambitToAct(s) returns 'p2' (correct) while actorFor(s) returns 'p1'. So every AI-driven and soak game lets one player resolve all their gambits consecutively before the opponent may respond.

**Fix.** Two changes. (a) In actorFor, replace the passedGambit-only branch with `return gambitToAct(state)` so the driver follows the same selector the UI does. (b) Enforce the order in the reducer rather than documenting its absence: in UseGambit and PassGambit, reject when gambitToAct(next) !== intent.player so an out-of-turn gambit lands in state.rejected like any other illegal intent.

**Risk.** Low, but (b) will surface as rejected intents in soak runs if (a) is not landed in the same change — the acceptance tests assert zero rejected intents for AI-driven games, so do both together.

Files: `src/ai/runner.ts`, `src/core/reducer.ts`, `src/core/phases.ts`

Test: tests/rules-review.test.ts quoting core-rules.txt:183: with initiative p1, strategyStep 'gambit' and p1 having used one gambit, a second UseGambit from p1 is rejected while one from p2 is accepted; and two passes in succession end the step.

### W-38 · A granted free action is modelled as +1 APL, so the ±1 clamp cancels it against any other APL change

**OPEN** · engine · minor · **needs an owner decision**

Rules pinned: `core-rules.txt:454 ("Regardless of how many APL STAT CHANGES an operative is affected by, the total can never be more than -1 or +1 from its normal APL. This takes precedence over all stat changes")`

**Problem.** Verified still open at src/teams/helpers.ts: grantFreeAction implements "can immediately perform a free 1AP action" by pushing +1 onto op.aplMods — the same array that carries genuine APL stat changes — and aplOf clamps the total to [-1,+1]. So an operative already at +1 APL from a ploy gains nothing from a granted free action (raw +2 clamps to +1), and an operative at -1 APL spends the free action undoing the debuff instead of performing it in addition. Reproduced: aplMods [1,1] yields APL 3 for a base-2 operative, not 4. This is the consequence already recorded in docs/DECISIONS.md D-015, which names Kasrkin SEIZE THE INITIATIVE / RELOCATE / COVER RETREAT and Angels of Death WRATH OF VENGEANCE as affected.

**Fix.** Keep free actions out of op.aplMods. Add a separate counter (op.freeAp, or derive it from the FREE_ACTION_RULE effects already created alongside the push in helpers.ts) and have the AP check in the reducer read `aplOf(...) + freeApAvailable(...)`. That keeps the ±1 clamp applying to real stat changes only, as the precedence clause requires, and leaves the existing canPerformAction restriction to the rule's named actions working unchanged.

**Risk.** D-015 is a documented modelling choice the owner made deliberately, so this is a request to revisit it rather than a straightforward bug fix. It touches ~30 team modules' expectations about how their free action behaves, and APL is simultaneously a marker-control input — do not let free AP leak into markerController.

Files: `src/teams/helpers.ts`, `src/core/state.ts`, `src/core/reducer.ts`, `docs/DECISIONS.md`

Test: tests/rules-review.test.ts quoting core-rules.txt:454: a base-APL-2 operative already at +1 APL that is granted a free 1AP action can spend 4AP that activation, and one at -1 APL that is granted a free action can spend 2AP; in both cases aplOf itself still reports the clamped stat, because APL is also read for marker control.

### W-39 · The Ceiling "regardless of the operative's height" exemption is still dead at the final-placement check

**FIXED** · engine · minor

Rules pinned: `killzones.txt:235 ("Operatives with a round base of 50mm or less, or an oval base of 60x35mm, can move underneath Ceiling terrain regardless of the operative's height (this takes precedence over Terrain and Movement). The operative must still finish the action in a location it can be placed")`

**Problem.** Half fixed. pathBlockedByTerrain now honours the precedence properly (`hasType(part,'Ceiling') && part.z0 >= z + 1e-6 && baseFitsUnderCeiling(base)` skips the part), so an increment may pass underneath. But baseBlockedByTerrain (src/core/terrain.ts:245-256) still has the test inside `if (part.z0 >= z + height - 1e-6) { if (hasType(part,'Ceiling') && baseFitsUnderCeiling(base)) continue; continue; }` — both arms continue, so the Ceiling branch can never change the result, and when the operative IS taller than the clearance control falls through to the overlap loop and the position is rejected. Latent on current data only by luck: every shipped Ceiling part sits at z0 3.0/3.5/6.0 and the tallest MODEL_HEIGHT_BY_BASE entry is 2.5". Any Volkus re-extraction that lowers a stronghold level below 2.5" — which is exactly what W-04 does — or any datacard that sets an explicit height turns it into a hard placement block.

**Fix.** Make the Ceiling test a precondition of the overlap loop rather than a branch of the entirely-above case: skip any Ceiling part for a qualifying base whenever the operative is passing or standing underneath it (part.z0 > z), and keep the overlap test only for bases that do not qualify. canStandAt and the other final-placement checks already cover "must still finish in a location it can be placed".

**Risk.** None today, but sequence it BEFORE or WITH W-04, which is the change most likely to produce a Ceiling part low enough to trip it.

Files: `src/core/terrain.ts`

Test: tests/rules-review.test.ts quoting killzones.txt:235: a Ceiling part with z0 = 2.0 over a 32mm-based operative of model height 2.2" — the operative may both move under it and FINISH under it; a 60mm-based operative in the same spot is rejected.

## Gaps in the audit itself

- ALREADY FIXED SINCE THE AUDIT SNAPSHOT — do not re-plan these. I verified each against the tree at HEAD 4e78620 plus the uncommitted diff. Committed: (1) `no-mid-move-control-range-or-enemy-bases` / `move-ignores-enemy-control-range` / `move-through-enemy-operatives` — three findings of one defect, fixed in 4e78620; movement.ts:317 `enemyOnTheWay` now samples every leg at 0.2" against enemy bases and control range, honours `mayEnterEnemyControlRange` and the already-engaged and friendly-screened exceptions. Only the Charge sticky half remains, as W-18. (2) `same-floor-gives-cover` — fixed in e6c3181 by an `underfoot` skip-set in interveningParts. (3) `control-range-through-solid-floors` — fixed in e6c3181; `controlRangeIgnores` is now scoped to volkus.strongholdA/B plus large-ruin doors and reads part HEIGHT (p.z1 < 2), not thickness. (4) `seek-removes-cover-save` / `seek-removes-the-cover-save` / `vantage-light-cover-removes-cover-save` — one defect found from three angles, fixed in e6c3181; CoverResult now carries both `inCover` (drives the save) and `inCoverForTargeting` (drives the Conceal gate), and `vantageImprovedCover` fires when the denial is what made the target valid, feeding the +1 cover save. (5) `vantage-heavy-filter-also-kills-cover` — fixed by the new `CoverOpts.ignoreForObscured`. (6) `blocked-normals-counted-as-retained-crits` — fixed in 76d4e74 via `DieState.blockedFrom`, so Devastating and Stun in shoot now count true retained crits. (7) `reroll-drops-lethal-and-hit-mods` / `lethal-lost-on-reroll` — fixed in 76d4e74; decisions.ts now carries the full ClassifyOpts into `rerollDie(die, v, hit, classify)`. (8) The ranged-profile half of `retaliation-uses-first-profile-not-a-melee-one` — fixed in 76d4e74 (`meleeProfileOf`, and sideWeapon falls back to `profiles.find(p => p.type === 'melee')`); the missing CHOICE is W-21. (9) `command-reroll-capped-once-per-tp` / `command-reroll-capped-once-per-turning-point` — fixed; decisions.ts:161 keeps `commandReroll*` out of ploysUsedTP and all three offer sites gate on CP alone. Uncommitted in the working tree right now (src/core/dice.ts, sequences/fight.ts, sequences/shoot.ts, sequences/types.ts, tests/rules-review.test.ts): (10) `punishing-usable-while-obscured` (critsAllowed guard added), (11) `fight-rerolls-not-alternating-and-wrong-starting-player` (single alternating step seeded from state.initiative, with rerollsDone pass tracking), (12) `melee-stun-never-applies` / `stun-inert-in-melee` (new applyStun at the end of retention), (13) `cannot-block-with-nothing-to-block` (canBlock gate dropped, label changed), (14) `torrent-secondaries-inherit-cover` (new seq.spread; Torrent secondaries re-run checkTarget). Finish and land that diff before starting W-17, which edits the same function.

- KNOWN-1 and KNOWN-2 are both already committed, not merely in progress: 3d22ad2 landed solid-terrain leg blocking (pathBlockedByTerrain with the Accessible/Insignificant/Ceiling exemptions and the climb/drop feature exemption) and the Volkus doors — all six maps now carry 4 role:'door' Accessible+Heavy parts. Two items in this plan touch that work: W-09 (mines are NOT fixed by leg checking, because checkMines is not called from validateMove) and W-18 (the Charge sticky set should be derived from the same path sampling, and multi-waypoint routing in src/ai/moves.ts must learn it).

- Noted by the auditors but never filed as findings, and still true — worth a triage pass rather than a work item each: Severe's "Punishing and Rending don't [take effect]" precedence is violated (reproduced at 10 damage instead of 8) but no shipped datacard pairs Severe with either, so it cannot change a game today. Accurate's "up to x" is forced to the maximum rather than offered as a choice. Barred proximity is measured from the base CENTRE (distancePointToPoly(fromBody.pos, …)) instead of the base, ~0.63" stricter than "horizontally within 1\"" for a 32mm base. `treatAsZ: 3.0` is written onto every Volkus largeRuin floor per killzones.txt:277 and read by nothing, so interveningParts still sees a 0.5" height difference and switches from 2D to 3D targeting lines. killzones.txt:445/:450 (Operate Hatch performed mid-Dash/Reposition, and opening a hatchway into an enemy's control range ending that move) has no implementation — there is no mid-move action seam anywhere. OnGuardInterrupt's intent type is literally `action: 'Shoot' | 'Fight'`, so killzones.txt:553's "(including actions that are treated as such, e.g. Hatchway Fight)" is unreachable by construction. Breach's "cannot perform for less than 2AP after Charge or Shoot" (killzones.txt:523) exists only as a comment. The condenser battlements are declared in data/terrain/bheta-decima.json and emitted on 0 of 6 maps, and bheta-decima-6 is missing its inner ledge. The Bheta-Decima equipment relaxation (killzones.txt:609) and the Tomb World "no equipment within 2\" of a teleport pad" rule are both absent from src/core/equipment/. No map or terrain JSON anywhere carries a Barred or Blocking part, so the (correct) Barred implementation in visibility.ts:112 is unreachable and Volkus large-ruin unbroken windows are unmodelled. The whole Compound Siege upgrade — stockades, bunkers, fire steps, Fortified Position, Open Stockade Door, stockade Wounds 8 — is unimplemented, but no Compound Siege map ships.

- Genuine sweep gaps in the 15-domain audit itself, which this plan therefore cannot speak to: (a) no domain audited the 48 team modules' own rules, ploys, equipment or unique actions — that is the single largest body of rules code in the repo (src/teams/**) and docs/TEAM-STATUS.md is the only record of its state; (b) no domain audited the AI beyond the four places it mirrors a core filter (legal.ts pickup, missionCandidates, actorFor, moves.ts), so evaluation and search are unreviewed; (c) no domain audited replay determinism end to end — several items here (W-11 above all, plus W-09 and W-17) change RNG draw counts, and nothing in the plan pins the byte-identical-replay invariant that CLAUDE.md architecture rule 2 promises; (d) no domain audited the UI beyond the crit-op action sheet, so the rest of commandPlan is unreviewed against docs/UI.md; (e) approved-ops-2025.txt does not contain card text for crit ops 4-9, so those six were audited against the app's own vendored data/ops/crit-ops.json — accurate for ops 1-3 where a cross-check was possible, unverified against the printed cards for the rest.

- Suggested landing order given the dependencies I found: W-03 before W-01 (so re-extracted split walls inherit working corner/end zones); W-39 with or before W-04 (W-04 is the change most likely to produce a Ceiling part low enough to trip the dead guard); W-14 before W-28 and W-30 (all three want the same within-2\"-and-other-side-of-the-part helper); W-04 before W-29 ("wholly within a stronghold" and "or a fire step" are meaningless until the wall bands and key C exist); the uncommitted fight.ts diff before W-17 and W-21. W-11 should be its own commit with a deliberate re-baseline of every seeded fixture.
