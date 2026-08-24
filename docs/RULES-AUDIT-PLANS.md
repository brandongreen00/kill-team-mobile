# Rules audit — verification pass, 2026-08-24

The twelve items still open in `docs/RULES-AUDIT.md`, re-verified against HEAD `a775289` by ten
agents — five investigators, five adversarial verifiers whose brief was to refute them. Machine
generated from that run and then read; treat the prose as the agents' words, not the owner's.

Every finding was **proved by running code**, not by reading it. Investigators had to build a
reproduction under a scratch vitest config and paste its output, because three claims in the
original audit had already turned out to be wrong when checked that way: Gellerpox BARGE's
"unused" `mayMoveThroughEnemies` (it is folded in by `movePermissions`), W-34's "16 test
fixtures" (32, across 14 files), and W-24's proposed fix (it would have double-counted, because
the module registers once per player).

**All twelve are still live.** The verifier refuted one item's *reasoning* outright — W-22, where
Obstructing turns out to price a crossing without granting permission to make it — and rejected
eight of the twelve plans with run-backed objections. Those objections are reproduced under each
item and take precedence over the plan above them.

**Read the OWNER paragraphs first.** Most of these cannot land without a decision, and several are
the same kind of call as D-101's parapet: the cards simply do not print the number.

| Item | Effort | Original audit entry | Verifier accepts plan | Needs owner |
| --- | --- | --- | --- | --- |
| W-05 | large | wrong in part | False | no |
| W-18 | medium | wrong in part | False | yes |
| W-21 | medium | wrong in part | False | yes |
| W-22 | medium | wrong in part | False | yes |
| W-23 | medium | wrong in part | True | yes |
| W-28 | medium | wrong in part | False | yes |
| W-29 | large | wrong in part | True | yes |
| W-30 | medium | wrong in part | True | no |
| W-31 | small | wrong in part | False | no |
| W-32 | large | wrong in part | False | yes |
| W-33 | large | wrong in part | False | yes |
| W-36 | large | wrong in part | False | yes |

---

## W-05

*Effort: large · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

```
docs/rules-source/approved-ops-2025.txt:100 — "Score VP by performing mission actions and controlling objective markers." (Crit Op, in the list at :98-104 of the three ops each player must score from.)

docs/rules-source/the-missions.txt:152 (Secure) — "One objective marker the active operative controls is secured by your kill team until the enemy kill team secures that objective marker." followed at :154 by "An operative cannot perform this action during the first turning point, or while within control range of an enemy operative." and the VP at :157-159: "At the end of each turning point after the first: / If any objective markers are secured by your kill team, you score 1VP. / If more objective markers are secured by your kill team than your opponent's kill team, you score 1VP."

docs/rules-source/the-missions.txt:171 (Loot) — "Whenever a friendly operative performs the Loot action, you score 1VP (to a maximum of 2VP per turning point)."

docs/rules-source/the-missions.txt:178 (Transmission) — "One objective marker the active operative controls is transmitting until the start of the next turning point."

Crit ops 4-9 are NOT in docs/rules-source/ at all (grep for 'Orb token', 'Data point', 'inert objective' returns nothing). Their verbatim card text is vendored in data/ops/crit-ops.json:
  crit.orb, action 'Move Orb' — "If the active operative controls the objective marker that has the Orb token, move that token as follows: If the centre objective marker has it, move it to either player's objective marker (your choice). If a player's objective marker has it, move it to the centre objective marker."
  crit.data, action 'Send Data' — "Remove all Data points from an objective marker the active operative controls." VP: "Whenever a friendly operative performs the Send Data action, you score a number of VP equal to the number of Data points removed."

And the architecture rule this fix is constrained by, CLAUDE.md § How to… Change the phone UI: "The UI may read any non-mutating (ctx, state, …) selector from src/core/** and may never re-implement one — if the answer is not exported, add a named selector to the core in the same change".
```

### Where the original entry is wrong

Live, and the mechanism is exactly as described — but four material corrections.

(1) THE HEADLINE NUMBER IS WRONG. It is FOUR crit ops that score 0VP, not five: Secure, Loot, Transmission, Data. Proven two independent ways. Structural probe (w05score.test.ts) gives P1 an operative on ALL THREE objective markers with P2 nowhere near, scores TP1-4 + end of battle with no mission action ever performed: crit.secure 0VP, crit.loot 0VP, crit.transmission 0VP, crit.data 0VP — and crit.orb 6VP, crit.reboot 6VP, crit.stakeClaim 3VP, crit.energyCells 3VP, crit.download 3VP. A/B bot games (w05ab.test.ts, 3 seeds x 2 players, mission actions surgically disabled) agree: secure 18->0, loot 15->0, transmission 4->0, data 4->0, orb 18->18, reboot 18->18, stakeClaim 6->6. Download and Energy Cells each lose a whole VP stream (Download's 1VP/TP3 + 2VP/TP4 award; Energy Cells' end-of-battle carrying VP) but keep their marker-majority stream. Orb loses no VP at all — it loses its only interactive play, the denial of putting the token on the enemy's marker.

(2) THE PROPOSED FIX IS THE WRONG SELECTOR. The audit says activeControls 'wants a plural wrapper'. It does not: different actions accept different marker sets. Download excludes YOUR OWN objectives (objectiveOwner === op.player is refused), Reboot requires isInert, Pick Up Intelligence wants a kind:'intelligence' marker, Ammo Resupply a kind:'ammoCache' marker, Move Orb takes no markerId at all. Only def.check knows. The selector to add is an enumerator over def.check, prototyped and proven in w05proto.test.ts. Also activeControls is at src/core/ops/common.ts:144, not :150 — and src/core/actions.ts must NOT import ops/common.ts anyway (it already has `terrain` from context.ts and `aliveOperatives` from state.ts, which is all the enumerator needs; ops/common.ts does not import actions.ts today, so the import would not cycle, but it is unnecessary).

(3) 'Move Orb ... needs params.choice' is half true. It needs `choice` only for the centre->player leg. The player->centre leg is legal with {} — proven in w05orb.test.ts: after moving the token to p2, check(ctx,st,op,{}) returns {ok:true} and reduce with params {} succeeds ('A moves the Orb token to centre'). actionAvailability already reports that leg ok:true today; it is simply unreachable because leg 1 never happens.

(4) THE ROW SHAPE IS NOT UNIFORM. 'the row comes back ok:false with needsTarget undefined' is right for the seven crit-op actions but wrong for Pick Up Marker, which IS already in NEEDS_TARGET, comes back ok:true/needsTarget:'marker', renders as an ENABLED button and dispatches a rejection ('no such marker' — proven). Same for Operate Hatch on gallowdark-1 (ok:true, needsTarget:'part', bare dispatch rejected 'no hatchway access point selected', {partId} succeeds) — so Gallowdark hatchways are equally unopenable in the shipped UI. Place Marker is likewise enabled but is NOT broken: its check tolerates {} (markerPos optional, defaults to op.pos).

Also accurate but worth firming: `grep -rn markerId src/ui/` returns exactly 0 hits — verified. src/ui/ActivationPanel.tsx (the only other file that dispatches PerformAction with params) is dead code, imported by nothing.

THREE THINGS THE AUDIT DOES NOT SAY.
(a) The shipped app hard-codes critOpId: defaultCritOpId() = 'crit.secure' at src/ui/App.tsx:77 and :166 and src/ui/command/play.tsx:887, and `grep -rn 'critOp' src/ui/` shows NO crit-op picker anywhere. Every battle a human plays is the single worst-affected op and scores exactly 0VP from it. docs/UI.md's Known-gaps line ('state.critOpId is unset by default, so no crit op scores') is stale.
(b) Scale. Measured at HEAD (w05scope.test.ts): 279 registered actions read a param and 271 of them are absent from NEEDS_TARGET. Beyond the 8 crit-op actions that is 6 tac-op actions, 3 universal-equipment actions (Ammo Resupply, Smoke Grenade, Stun Grenade) and ~100 team unique actions (Charge (Jump Pack), Shoot (Astartes), Place Marker (Krieg Mine), ...) — the UI's isMoveAction only matches the four bare move ids, so every team's move/shoot variant is a plain button dispatched with no params. That is NOT W-05 and needs its own audit item.
(c) The audit's Test line says 'quoting the-missions.txt:171'. That works for Loot only. docs/rules-source/ carries crit ops 1-3 only (the-missions.txt:152 Secure, :171 Loot, :178 Transmission). Ops 4-9 appear nowhere in the corpus — `grep -rn 'Orb token|Data point|inert objective' docs/rules-source/` returns nothing. Their verbatim card text is in data/ops/crit-ops.json, which is what tests for Orb/Download/Data/Reboot must quote.

### Evidence (run, not read)

All runs with: cd /home/user/kill-team-mobile && npx vitest run --config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vitest.w05.config.ts <file>  (a jsdom+preact-aliased copy of the scratch config; the plain vitest.scratch.config.ts cannot collect .tsx).

[1] w05core.test.ts — actionAvailability for every crit op at TP2/3/4, operative standing on the centre marker. Verbatim output for Secure (identical shape for Loot, Initiate Transmission, Download@TP3+, Compile Data, Send Data@TP4, Reboot):
  crit.secure tp2 · Secure: availability ok=false needsTarget=undefined reason=select an objective marker | check({}) ok=false (select an objective marker) | check({markerId:centre}) ok=true (-)
  crit.orb tp2 · Move Orb: availability ok=false needsTarget=undefined reason=select a player's objective marker to move the Orb token to
  crit.stakeClaim tp2 · (no mission action offered)   crit.energyCells tp2 · (no mission action offered)
So the core says LEGAL with a param and actionAvailability reports ok:false, needsTarget undefined.

[2] w05ui.test.ts …[truncated]

### Plan

Land the core selector and the UI branch IN ONE COMMIT. Adding an id to NEEDS_TARGET on its own flips a correctly-disabled row into an enabled row the reducer rejects — that is precisely what Pick Up Marker does today (proven).

=== 1. src/core/actions.ts ===

(a) Line 661: `export type ActionTargetKind = 'point' | 'operative' | 'part' | 'marker' | 'markerChoice';`  ('markerChoice' exists for Move Orb, whose param is `choice` and which takes no markerId at all.)

(b) NEEDS_TARGET (line 663-676) gains, in this change only, the ids whose kind the UI branch below actually renders:
    Secure: 'marker', Loot: 'marker', 'Initiate Transmission': 'marker', Download: 'marker',
    'Compile Data': 'marker', 'Send Data': 'marker', Reboot: 'marker', 'Move Orb': 'markerChoice',
    'Plant Device': 'marker', Retrieve: 'marker', Clear: 'marker', 'Pick Up Intelligence': 'marker',
    'Ammo Resupply': 'marker'
  Do NOT add Scout ('operative'), Plant Banner / Smoke Grenade ('point') or Stun Grenade ('operative') here — there is no UI branch for those kinds yet and they would become enabled dead buttons.

(c) New exported selector immediately after actionAvailability. It needs nothing that actions.ts does not already import (`terrain` from ./context.ts line 11, `aliveOperatives` from ./state.ts line 16) — do not import src/core/ops/common.ts:

    export interface ActionTargetOption { id: string; label: string; params: ActionParams; }

    /**
     * Every parameter set this action would accept RIGHT NOW, judged by the action's own
     * `check`. The counterpart of `validTargets` for the parameterised actions. The UI must
     * not decide which markers an action considers: Download refuses your OWN objectives,
     * Reboot requires an inert one, Pick Up Intelligence wants an `intelligence` marker and
     * Ammo Resupply an `ammoCache` one. Only `check` knows.
     */
    export function actionTargetOptions(ctx, state, op, def): ActionTargetOption[] {
      switch (NEEDS_TARGET[def.id]) {
        case 'marker':
          return Object.values(state.markers)
            .map((m) => ({ id: m.id, label: markerLabel(m), params: { markerId: m.id } as ActionParams }))
            .filter((o) => def.check(ctx, state, op, o.params).ok);
        case 'markerChoice': {
          const out: ActionTargetOption[] = [];
          // The bare form FIRST: when the token is already on a player's marker the rule
          // gives no choice ("move it to the centre objective marker") and check accepts {}.
          if (def.check(ctx, state, op, {}).ok) out.push({ id: '', label: 'the centre objective marker', params: {} });
          for (const m of Object.values(state.markers)) {
            if (m.kind !== 'objective') continue;
            const params: ActionParams = { choice: m.id };
            if (def.check(ctx, state, op, params).ok) out.push({ id: m.id, label: markerLabel(m), params });
          }
          return out;
        }
        case 'part':
          return terrain(ctx, state).parts
            .filter((p) => p.role === 'accessPoint')
            .map((p) => ({ id: p.id, label: p.id, params: { partId: p.id } as ActionParams }))
            .filter((o) => def.check(ctx, state, op, o.params).ok);
        default:
          return []; // 'point' and 'operative' are aimed on the board, not listed.
      }
    }
    const markerLabel = (m: MarkerState): string =>
      m.kind === 'objective' ? `objective ${m.id.replace(/^obj\./, '')}` : `${m.kind} marker`;

(d) actionAvailability (line 693-711): for a row whose needsTarget is one of the ENUMERABLE kinds ('marker' | 'markerChoice' | 'part'), replace the blind `return { ...row, needsTarget }` with
      const opts = actionTargetOptions(ctx, state, op, row.def);
      if (opts.length > 0) return { ...row, needsTarget };
      const why = row.def.check(ctx, state, op, {}).reason;
      return { ...row, ok: false, needsTarget, ...(why ? { reason: why } : {}) };
  Leave 'point' and 'operative' on the existing short-circuit untouched — enumerating a point means a flood fill, and the comment at 697-705 is right that reason strings must not be sniffed. Keep that comment and extend it to say why the enumerable kinds are now decided authoritatively instead.
  Side effect, wanted: Pick Up Marker and Operate Hatch stop being enabled dead buttons.

=== 2. src/ui/command/types.ts ===
  UiState gains, next to `move` and `weaponName`:
    /** A parameterised action being aimed at a marker or access point: the action id. */
    aimAction?: string | undefined;
  CommandPlan gains, next to `targetIds`:
    /** Markers the current step invites a tap on. */
    targetMarkerIds?: readonly string[];

=== 3. src/ui/command/play.tsx ===
  - line 18: import { actionAvailability, actionTargetOptions, getAction, type ActionTargetOption } from '../../core/actions.ts';
  - line 45 area: const AIMABLE = new Set(['marker', 'markerChoice', 'part']);
  - after line 375 (`if (ui.move) return movePlan(...)`), before line 381:
        if (ui.aimAction) return aimPlan({ store, ui, setUi }, op, ui.aimAction);
  - new function aimPlan(args, op, actionId): CommandPlan, modelled on shootPlan (line 720+):
        const def = getAction(actionId); if (!def) { setUi({ aimAction: undefined }); return activationPlan(args); }
        const options = actionTargetOptions(ctx, state, op, def);
        id: 'firefight.aim'
        step: `Turning point ${state.turningPoint} · ${LABEL[op.player]}`
        title: def.name
        help: 'Tap the marker on the killzone, or pick one from the list.'
        detent: 'half'   // the list IS the screen — the same reason shootPlan asks for half
        turnOf: op.player, selectedId: op.id
        frame: framing-style rect over op.pos plus every option's marker pos, pad 3, else rectAround(op, 8)
        targetMarkerIds: options.map(o => o.id).filter(Boolean)
        armed: { onMarker: (m) => { const o = options.find(x => x.id === m.id); if (o) commit(o); },
                 commit: () => undefined }   // the tap-swallower shootPlan already uses
        actions: [{ id: 'cancel-aim', label: 'Cancel', tone: 'quiet', icon: <IconUndo size={20}/>, onClick: () => setUi({ aimAction: undefined }) }]
        body: <><div class="actions">{options.map(o => <button key={o.id} onClick={() => commit(o)}><span class="entry-name">{def.name} {o.label}</span></button>)}</div>
               {options.length === 0 && <p class="err">Nothing this operative controls can be {def.name.toLowerCase()}ed right now.</p>}
               <p class="rule-text printed">{def.sourceText}</p></>
        commit = (o) => { store.dispatch({ t: 'PerformAction', operativeId: op.id, action: actionId, params: o.params }); setUi({ aimAction: undefined }); };
  - the action row, lines 480-495. Hoist one enumeration per render above the JSX:
        const aimOptions = new Map<string, ActionTargetOption[]>();
        for (const r of rows) if (r.needsTarget && AIMABLE.has(r.needsTarget)) aimOptions.set(r.def.id, actionTargetOptions(ctx, state, op, r.def));
    then line 487 becomes:
        onClick={() => {
          if (isMoveAction(def.id)) return setUi({ move: { action: def.id } });
          const opts = aimOptions.get(def.id);
          if (!opts) return perform(def.id);
          if (opts.length === 1) return perform(def.id, opts[0]!.params as Record<string, unknown>);
          return setUi({ aimAction: def.id });
        }}
    and the label gains the marker when there is exactly one option (`Loot objective centre · 1AP`) or `· pick a marker` when there is more than one, so the one-tap path still says what it will do.

=== 4. src/ui/Board.tsx ===
  - ArmedState (line 123-133) gains: `/** Marker-picking: a tap on a marker resolves here. */ onMarker?: (m: MarkerState) => void;`
  - BoardProps (line 161 area) gains `targetMarkerIds?: readonly string[];`
  - the `.markers` group (lines 653-666): keep the true-scale stroke, add an invisible hit disc of radius max(r, (MIN_TAP_PX/2)*inPerPx) exactly as the operative branch does, an onClick that calls e.stopPropagation(), bails on gestureConsumedClick() and then armedRef.current?.onMarker?.(m); add class={`marker${isTarget ? ' is-target' : ''}`} and, when isTarget, the same `.target-ring` circle drawn at lines 724-733 (r + 0.22, #ffc94a, stroke-width 0.08).
  - src/ui/App.tsx passes targetMarkerIds={plan.targetMarkerIds} to <Board>.

=== 5. src/ui/styles.css ===
  Next to `.op.is-target .target-ring` (line 1167): `.marker.is-target .target-ring { animation: target-pulse 1.6s ease-in-out infinite; }`

=== 6. src/ai/legal.ts ===
  missionCandidates (line ~215): seed `attempts` from actionTargetOptions(ctx, state, op, def).map(o => o.params) BEFORE the existing heuristic list, keeping the heuristics as the fallback for team unique actions the table does not cover. This is what makes {choice} reachable and unfreezes the Orb token in bot games. Leave the trial-reduce-on-a-forked-RNG confirmation exactly as it is.

=== 7. Docs ===
  docs/UI.md — add a row to the State → screen table between `firefight.shoot` and `firefight.guardInterrupt`:
    | an action aimed at a marker | `firefight.aim` | framed on the operative and every legal marker, each ringed | pick a marker, Cancel |
  add `actionTargetOptions` to the 'What the UI may read from the core' table with its reason ('the action list offered mission actions it could not aim, so five crit-op actions were permanently disabled buttons'), and correct the stale Known-gaps sentence 'state.critOpId is unset by default, so no crit op scores' — it is set to crit.secure on every boot.
  docs/DECISIONS.md — new D-1xx: a parameterised action is aimed through ONE generic `firefight.aim` branch driven by a core enumerator over def.check, never a per-op screen and never a UI-side list of which markers an action wants.

### Verifier objection — takes precedence over the plan above

W-05 IS live — I reproduced it independently (re-ran w05ui.test.tsx: real Store, real commandPlan, plan id firefight.act, row "Secure · 1APselect an objective marker" disabled=true, click leaves history ["ActivateOperative"] and markers.centre.flags {}; a hand-built PerformAction with {markerId:'centre'} returns ok=true). Mechanism confirmed by reading src/core/actions.ts:693-711 (`if (needsTarget) return {...row, needsTarget}` never reached, so `def.check(ctx,state,op,{})` decides) and src/ui/command/play.tsx:480-495 (`disabled={!ok}`, `onClick={... perform(def.id)}` with no params). Nothing in D-001..D-102 covers it (D-102 is the last). But the plan is NOT sound, and one headline evidence claim is wrong.

=== 1. THE PLAN'S `markerChoice` BRANCH IS WRONG, AND IT CONTRADICTS THE REPORT'S OWN TEST PLAN. PROVEN. ===
I implemented the plan's markerChoice branch verbatim and ran it in BOTH Move Orb legs (/tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/w05v-orb.test.ts):
  LEG 1 options: [{"choice":"p1"},{"choice":"p2"}]  — 2, as claimed.
  LEG 2 options: 4 — {} , {choice:'p1'} , {choice:'centre'} , {choice:'p2'} — and I pushed every one through reduce(): all four return ok=true and all four log the IDENTICAL 'A moves the Orb token to centre'.
Cause: src/core/ops/crit/orb.ts:38-48. `check` only inspects `params.choice` inside `if (objectiveSide(state, orb) === 'centre')`; on the other leg it falls straight to `return { ok: true }` whatever `choice` says, and `perform` (:50-56) ignores `choice` entirely on that leg. So `def.check` — the very thing the plan says is the only authority — accepts three junk params.
Two consequences. (a) The UI would open a four-button aim screen offering a choice the printed rule does not give: data/ops/crit-ops.json crit.orb, "If a player's objective marker has it, move it to the centre objective marker" — no choice clause, unlike the centre leg's "(your choice)". (b) The report's own testPlan item 3 says "with the token on a player's marker and the operative on it, assert the row dispatches directly with params {} (one legal option, no aim screen)". Against the report's own selector that assertion FAILS: leg 2 has four options, so the plan's row logic (`opts.length === 1` → direct dispatch, else `setUi({aimAction})`) opens the aim screen. The report never ran the enumerator in leg 2 — evidence [8] only covers tp2 leg 1, evidence [9] calls `check({})` directly, never the enumerator. This is exactly the "asserting on a helper in isolation while the real path differs" failure.

=== 2. "crit.orb loses no VP at all" IS FALSE — it is one of the WORST-hit ops. PROVEN. ===
/tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/w05v-orbvp2.test.ts, ordinary board (p1 controls the centre marker and its own, p2 controls its own), scoring TP2-4:
  frozen token on centre (the shipped UI): p1 3VP, p2 3VP
  after exactly ONE Move Orb with {choice:'p2'}: p1 6VP, p2 0VP
A 6VP swing in an 18-21VP game — larger than any other number in the report. The report's evidence [6] A/B (orb 18→18) does not show what it claims: the report's OWN evidence [5] records "mission-action log entries=0" for crit.orb on all three seeds in the NORMAL arm, so both arms of that A/B are the same game and the comparison is vacuous. Evidence [7]'s structural probe gives P1 all three markers — the single board state where moving the token cannot change P1's own count (I re-ran it: crit.orb 6VP either way). Both probes are blind to the effect by construction.

=== 3. PLAN STEP 6 CONTRADICTS A DOCUMENTED INVARIANT IN missionCandidates. ===
src/ai/legal.ts:236-238 puts `attempts.push({})` LAST on purpose, with the comment "several ops accept it in `check` and then fail in `perform` ... which the reducer reverts AND records as a rejection". The plan says to seed `attempts` from `actionTargetOptions(...).map(o => o.params)` BEFORE the heuristics — and the plan's own markerChoice branch emits `{}` FIRST. Also `if (out.length >= 3) break` (legal.ts:250) caps the list, so seeding displaces heuristics for any action the table covers.

=== 4. PLAN (d)'s FALLBACK REASON IS STILL A PARAMETER REASON. PROVEN. ===
/tmp/.../w05v-purity.test.ts, operative 12" from every marker: options = 0, and `def.check(ctx,state,op,{}).reason` = "select an objective marker", while the aimed check gives the true reason "the active operative does not control that objective marker". The plan's rationale says (d) makes enumerable rows "decided authoritatively", but the string it puts under the disabled row is precisely the parameter reason the comment at src/core/actions.ts:697-705 exists to keep out of the UI. No worse than today, but it is not the fix the plan claims.

=== 5. CITATION ERROR IN ownerDecisionNeeded (a). ===
"the D3 roll the rules actually print — approved-ops-2025.txt:99 'Determine one shared crit op'". Line 99 is the heading "Crit Op"; that sentence is at approved-ops-2025.txt:114 and prints no D3. The only crit-op D3 in the corpus is the-missions.txt:145, "The player with initiative rolls one D3. The players use the crit op that corresponds to the result." — core book, ops 1-3 only. Approved Ops 2025, the ruleset this project targets, says the opposite at :111: "tournament organisers should select crit ops for players in each round of the tournament, either randomly or predetermined", listing all nine at :152-153. A D3 is the wrong default for a nine-op picker.

=== 6. TWO OVERSTATED CORRECTIONS. ===
(a) "crit ops 4-9 appear nowhere in the corpus" — their card TEXT is absent (I confirmed "Orb token"/"Data point"/"inert objective" return nothing), but the names are printed at approved-ops-2025.txt:152-153 and :273, tomb-world.txt:886, typhon.txt:670. The operative conclusion (quote data/ops/crit-ops.json) stands.
(b) "THE HEADLINE NUMBER IS WRONG ... FOUR not FIVE". Four score literally 0VP — I re-ran w05score.test.ts and got secure/loot/transmission/data = 0. But crit.energyCells is equally unplayable for a human: it registers no mission action, and its whole VP stream runs through Pick Up Marker (src/core/ops/crit/energyCells.ts:27-46 prices it; `init` sets `pickUpAllowed`), which is the enabled dead button that dispatches "no such marker" (I re-ran w05ui2.test.tsx and reproduced the rejection). So "five crit ops a human cannot play" is a defensible reading of the audit sentence; calling it a headline error overstates the correction.

=== WHAT I CHECKED AND FOUND SOUND (the plan survives on these) ===
- PURITY: 200 repeated `def.check` calls per crit-op action across seven crit ops leave JSON.stringify(state) byte-identical. Safe to run per render.
- `p.role === 'accessPoint'` is the correct filter for BOTH Operate Hatch (src/core/actions.ts:542) and Breach (:585). gallowdark-1: 35 parts, 10 access points, 0.100 ms/render to enumerate both actions. Breach will not be wrongly disabled.
- actions.ts already imports `terrain` (line 11) and `aliveOperatives` (line 16); `ActionParams.choice` exists (src/core/intents.ts:94). No new import, no cycle. The report is right that ops/common.ts must not be imported.
- BLAST RADIUS: `actionAvailability` has exactly two consumers — src/ui/command/play.tsx:381 and tests/core.test.ts:370 — and `NEEDS_TARGET` is module-private. src/ai/** never calls actionAvailability, so change (d) cannot move bot behaviour. tests/core.test.ts:355-379 asserts only `Reposition.needsTarget === 'point'`, and the 'point' branch is untouched.
- Every id the plan adds exists and reads `markerId`: Plant Device (tac/plantDevices.ts:29,38), Retrieve (tac/retrieval.ts:36,46), Clear (tac/sweepAndClear.ts:43,52), Pick Up Intelligence (tac/stealIntelligence.ts:40,51), Ammo Resupply (equipment/ammoCache.ts:21,30).
- docs/UI.md:352-354 IS stale in BOTH halves: `defaultCritOpId()` (src/ui/data.ts:40) returns 'crit.secure' unconditionally, and there is no crit-op chooser in the menu either — `grep -rn critOp src/ui/` gives only App.tsx:77,:166, store.ts:157, play.tsx:887, data.ts:36. `grep -rn markerId src/ui/` is empty. src/ui/ActivationPanel.tsx is referenced nowhere but itself.
- Rule line numbers verified exactly: the-missions.txt:152, :154, :157-159, :171, :178; approved-ops-2025.txt:100.
- No CLAUDE.md invariant is violated: the selector is pure and lives in src/core, the UI reads it rather than re-implementing it, mutation stays intent-only, and `firefight.aim` is a branch of commandPlan in the same shape as movePlan/shootPlan.

Working tree untouched (git status --porcelain empty); every file I wrote is in the scratchpad.

### Corrected plan

Keep the item, keep the shape of the fix (core enumerator + one generic firefight.aim branch, landed in ONE commit). Six changes:

(1) FIX THE `markerChoice` BRANCH. The bare form is not an extra option, it is the WHOLE option set when the rule gives no choice. Replace the plan's body with:
    case 'markerChoice': {
      // "If a player's objective marker has it, move it to the centre objective marker" —
      // no choice clause, unlike the centre leg's "(your choice)". `check` accepts `{}` on
      // that leg and IGNORES a `choice` param (src/core/ops/crit/orb.ts:41), so enumerating
      // markers there would offer three buttons that all do the same thing.
      if (def.check(ctx, state, op, {}).ok)
        return [{ id: '', label: 'the centre objective marker', params: {} }];
      const out: ActionTargetOption[] = [];
      for (const m of Object.values(state.markers)) {
        if (m.kind !== 'objective') continue;
        const params: ActionParams = { choice: m.id };
        if (def.check(ctx, state, op, params).ok) out.push({ id: m.id, label: markerLabel(m), params });
      }
      return out;
    }
Pin it with a test that asserts leg 2 yields exactly ONE option and leg 1 exactly TWO — that is the assertion the report's testPlan item 3 already promises and which its own selector would have failed. (Optional follow-up, needs an owner decision because it narrows the reducer's accepted intent set: make Move Orb's check reject a `choice` param when `objectiveSide(state, orb) !== 'centre'`.)

(2) RE-RANK crit.orb IN THE ITEM AND IN docs/RULES-AUDIT.md. It is not "no VP lost, only interactive play" — one Move Orb turns 3-3 into 6-0 over TP2-4 on an ordinary board (p1 on centre + its own, p2 on its own). Quote data/ops/crit-ops.json crit.orb, and add that case to the scoring test (testPlan item 6) rather than the all-three-markers probe, which is blind to the effect. Drop the A/B's orb row from the evidence: both arms are the same game.

(3) AI SEEDING (plan step 6): seed the PARAMETERISED options first but keep every bare `{}` at the tail, preserving the invariant at src/ai/legal.ts:236-238. Concretely: `attempts.push(...actionTargetOptions(ctx, state, op, def).map(o => o.params).filter(p => Object.keys(p).length > 0))` before the heuristics, and leave the existing trailing `attempts.push({})` as the only source of the bare form. Also raise the `out.length >= 3` cap or count seeded options separately, so seeding does not starve the heuristics for team unique actions.

(4) PLAN (d) FALLBACK REASON: do not surface `check(ctx,state,op,{}).reason` — for Secure that is "select an objective marker" when the truth is "the active operative does not control that objective marker". When `opts` is empty, take the reason from `def.check` aimed at the NEAREST candidate of the right kind (nearest marker / nearest access point), and fall back to `check({})` only when there is no candidate at all. Keep and extend the comment at src/core/actions.ts:697-705.

(5) HEADLINE WORDING: say "four crit ops score literally 0VP (Secure, Loot, Transmission, Data) and a fifth, Energy Cells, is equally unplayable because its whole VP stream runs through the Pick Up Marker dead button" — do not present the audit's "five" as an error.

(6) OWNER QUESTION (a): reframe. The nine-op set comes from Approved Ops 2025, which says at :111 "tournament organisers should select crit ops ... either randomly or predetermined" and lists all nine at :152-153; the D3 at the-missions.txt:145 is the core book's three-op version and is not the right default. Ask for select-or-randomise from nine, and fix the citation to approved-ops-2025.txt:114 for "Determine one shared crit op".

Everything else in the plan stands as written: the enumerator in src/core/actions.ts (no ops/common.ts import — `terrain` at line 11 and `aliveOperatives` at line 16 are already there), the `part` branch filtered on `p.role === 'accessPoint'` (correct for Operate Hatch AND Breach, 10 parts / 0.1 ms on gallowdark-1), leaving 'point' and 'operative' on the existing short-circuit, the one-commit ordering, the Board `onMarker` + `targetMarkerIds` layer reusing `gestureConsumedClick()`, and the UI.md / DECISIONS.md updates.

### Test

1. tests/crit-ops-ui.test.tsx (new, jsdom, shaped like tests/allocate.test.tsx) — CORE HALF, quoting docs/rules-source/approved-ops-2025.txt:100 ("Score VP by performing mission actions and controlling objective markers"). For each of the eight crit-op mission actions, with an operative legally controlling the right marker in the right turning point (Secure/Loot/Initiate Transmission/Compile Data/Reboot at TP2, Download at TP3, Send Data at TP4 with flags.data=2, Reboot with flags.inertTP=tp, Move Orb at TP2 on the centre marker): assert the actionAvailability row has ok===true and needsTarget==='marker' (or 'markerChoice' for Move Orb); assert actionTargetOptions(...).length>=1; assert reduce(PerformAction with each option's params).ok===true and state.rejected.length===0. NEGATIVE HALF, same file: with the operative moved 12" from every marker the same row is ok===false with a reason and actionTargetOptions is []. That negative assertion is the one that stops the NEEDS_TARGET entries turning into enabled dead buttons.

2. Same file — UI HALF. Build a real Store (critOpId 'crit.secure', mode 'sandbox', TP2, operative on the centre marker), render commandPlan()'s body, find the button whose text starts 'Secure': assert it is NOT disabled; act(() => click()); assert store.history's last intent is {t:'PerformAction', action:'Secure', params:{markerId:'centre'}}, state.markers.centre.flags.secured==='p1', and store.lastRejection===null. (Today: disabled=true, history unchanged, flags {} — proven.)

3. Same file — the two-option path, quoting data/ops/crit-ops.json crit.orb ("If the centre objective marker has it, move it to either player's objective marker (your choice)"). With critOpId 'crit.orb' and the operative on the centre marker, clicking Move Orb yields plan.id==='firefight.aim' with exactly two option buttons; clicking one dispatches params.choice equal to that marker id and markers[choice].flags.orb===true. Then, with the token on a player's marker and the operative on it, assert the row dispatches directly with params {} (one legal option, no aim screen).

4. Same file — the dead-button regressions. (a) Pick Up Marker with the operative carrying nothing and 12" from every marker renders disabled with a reason, and no click can add to state.rejected (today: enabled, and one click writes {"reason":"no such marker"} into state.rejected — proven). (b) On gallowdark-1, Operate Hatch next to gallowdark-1.A3-1.access is enabled and clicking it opens THAT access point (today: enabled and rejected 'no hatchway access point selected' — proven).

5. tests/ops.test.ts — AI half, quoting data/ops/crit-ops.json crit.orb. playGame with critOpId 'crit.orb' on seeds 3, 7 and 11 (TacticalAgent veteran, tests/soak/fixtures arenaMap) logs at least one entry matching /moves the Orb token/ and result.rejected.length===0. Today all three seeds log zero — proven.

6. tests/ops.test.ts — the scoring half, quoting data/ops/crit-ops.json. Reproduce the probe-6 setup (P1 holds all three objectives, P2 in the far corner) and this time perform the crit op's mission action once per turning point through reduce(): crit.secure, crit.loot, crit.transmission and crit.data each score >0 across TP2-4. Today all four score exactly 0 with total board control — proven, and that is the assertion that pins the whole item.

7. Guard the existing test: tests/core.test.ts:355-379 asserts Reposition.needsTarget==='point'. It must still pass unchanged — the 'point' branch of actionAvailability is deliberately untouched.

8. Re-capture docs/ui-review/ and look at it (docs/UI.md § Screenshots), and add firefight.aim to the numbered sequence. Add an e2e assertion in e2e/smoke.spec.ts alongside the existing screenId(page)==='firefight.activate' checks that a crit-op action can be reached and performed.

### Risk

MEDIUM overall; the engine risk is near zero and all of it is in the UI and the AI.

1. Ordering hazard, the big one. Every id added to NEEDS_TARGET flips its row from ok:false to ok:true. If the UI branch does not land in the same commit, each becomes an enabled button that dispatches a rejection — the exact failure Pick Up Marker exhibits today. Core + UI must be one commit. The (d) change to actionAvailability (ok = options.length > 0) is what makes this safe and must not be dropped as an optimisation.

2. AI behaviour moves. Feeding actionTargetOptions into missionCandidates makes Move Orb reachable for the first time, so bot games with crit.orb diverge and any determinism fixture or recorded win-rate keyed on those seeds changes. The acceptance requirement (state.rejected===0) is safe: the enumerator only emits params def.check accepted, and missionCandidates still trial-reduces on a forked RNG. Verify the soak still reports zero rejected on all maps.

3. Test fixtures that encode the old shape. Only tests/core.test.ts:355-379 reads actionAvailability, and it asserts Reposition.needsTarget==='point', which is untouched. No test asserts a mission action is unavailable. Low.

4. Board.tsx gains a new interactive layer over the markers. The gesture rules in docs/UI.md are load-bearing — a press that wanders >8px must swallow its click, a second finger must cancel — so the marker handler has to reuse gestureConsumedClick() and e.stopPropagation() exactly as the operative branch does, or a pinch over an objective marker will spend an AP. Also: objective markers are 40mm (1.575"), smaller than a fingertip, so the invisible hit disc (MIN_TAP_PX) is required, and it must not steal taps from an operative standing ON the marker — the operatives group is painted after markers, so operative hits win, which is the right precedence for the deploy/move screens but must be checked on the aim screen where the marker is the target.

5. Cost. actionTargetOptions runs def.check once per marker per aimable action on every render. Measured: 0.087ms for 2 actions x 3 markers versus 0.017ms for the whole of actionAvailability today. ~0.1-0.4ms against a 16ms frame — fine, but hoist the enumeration into one Map per render rather than calling it once in actionAvailability and again in the row list.

6. Scope creep. 271 of 279 registered actions read a param and are absent from NEEDS_TARGET. This change fixes 8 crit-op actions, 4 tac-op marker actions, Ammo Resupply, and repairs Pick Up Marker / Operate Hatch / Breach. It does NOT fix Scout, Plant Banner, Smoke Grenade, Stun Grenade (need 'point'/'operative' aiming) or the ~100 team unique variants (Charge (Jump Pack), Shoot (Astartes), Place Marker (Krieg Mine), ...), which the UI's isMoveAction test at play.tsx:45 cannot see. Resist widening W-05 to cover them; raise a separate audit item.

7. docs/ui-review captures move (a new screen in the sequence), as does docs/UI.md's State → screen table.

### OWNER

No rules judgement is needed and nothing in D-001..D-102 covers this — the closest neighbours (D-054 equipment placement asks the engine cell by cell; D-056 manual allocation is a screen, not a second button; D-059 a plan's own detent is authoritative) all point the same way, so the fix is consistent with existing decisions rather than in tension with any.

Two product calls worth putting in front of the owner, neither blocking:

(a) THE CRIT-OP PICKER. Every battle in the shipped app is crit.secure, hard-coded at src/ui/App.tsx:77 and :166 and src/ui/command/play.tsx:887 via defaultCritOpId(), and `grep -rn 'critOp' src/ui/` shows no picker anywhere. crit.secure is the worst-affected op — 0VP for a human, always. Fixing W-05 makes it playable; it does not make the other eight crit ops reachable. Ask whether a crit-op selector belongs in this change (a list in the menu route beside the killzone browser, or the D3 roll the rules actually print — approved-ops-2025.txt:99 'Determine one shared crit op') or is its own item.

(b) THE ONE-OPTION SHORTCUT. When an operative controls exactly one marker — the ordinary case — the plan dispatches immediately from the action row with the marker named in the label ('Loot objective centre · 1AP') rather than opening the aim screen for a single button. That trades one tap for a row whose label changes shape between one and many options. The alternative is always showing the aim screen: one more tap on every Loot, but a fixed shape. I recommend the shortcut; the owner may prefer the uniform one.

### Files

`src/core/actions.ts`, `src/ui/command/types.ts`, `src/ui/command/play.tsx`, `src/ui/Board.tsx`, `src/ui/App.tsx`, `src/ui/styles.css`, `src/ai/legal.ts`, `docs/UI.md`, `docs/DECISIONS.md`, `tests/crit-ops-ui.test.tsx`, `tests/ops.test.ts`, `docs/RULES-AUDIT.md`


---

## W-18

*Effort: medium · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

```
docs/rules-source/core-rules.txt:282-289, Charge 1AP, verbatim:
  282: "Charge1AP"
  283: "The same as the Reposition action, except the active operative can move an additional 2\"."
  285: "It can move, and must finish the move, within control range of an enemy operative. If it moves within control range of an enemy operative that no other friendly operatives are within control range of, it cannot leave that operative's control range."
  287: "An operative cannot perform this action while it has a Conceal order, if it's already within control range of an enemy operative, or during the same activation in which it performed the Reposition, Dash or Fall Back action."
The same sentence recurs verbatim at core-rules.txt:721, killzones.txt:674, appendix.txt:307, approved-ops-2025.txt:351, the-missions.txt:552, volkus-compound.txt:399, tomb-world.txt:1129, typhon.txt:762, deadly-sniper.txt:356, universal-equipment.txt:259, airborn-assault.txt:283, blood-and-zeal.txt:279 — always inside the Charge paragraph, never with a duration.
Contrast core-rules.txt:277-279 (Fall Back): "the active operative can move within control range of an enemy operative, but cannot finish the move there" — no sticky clause, so the set must be built for Charge only.
```

### Where the original entry is wrong

Core claim CONFIRMED, but four things are wrong or stale.

(1) Line numbers: the sticky computation is now src/core/actions.ts:309-312 (not :252); the `if (opts.mayEnterEnemyControlRange) continue;` that discards the mid-path knowledge is src/core/movement.ts:396.

(2) The audit says stickyEngagedWith is "read by no file in src/core". It is stronger: it is read by NO file anywhere in src/. `grep -rn stickyEngagedWith src/` returns 14 assignment sites (actions.ts:312 plus 13 team modules), one object-literal initialiser in reducer.ts:140, the type declaration at types.ts:332, and the Gellerpox comment at gellerpox-infected/index.ts:205. Zero reads. It is also never cleared by ordinary movement, so it goes stale: I proved a charger that charged B (sticky=[B]) then Fell Back clean off B still reports stickyEngagedWith ['p2-1'] afterwards.

(3) The stated RISK is wrong in an important way. "src/ai/moves.ts must route around unscreened enemies or soak games gain rejected intents" cannot happen: every AI Charge intent is produced by buildPath (src/ai/moves.ts:224-255), which tries up to five candidate paths and returns null unless validateMove accepts one (`if (v.ok) return {...}; return null`). A stricter validateMove makes some Charges UNAVAILABLE, never rejected. What it does do is change which Charge the AI picks, which drifts seeded soak fixtures.

(4) The audit's FIX says "...and read it in later move validation so the teams' exemptions become meaningful". That is the PERSISTENT reading of core-rules.txt:285 (the restriction outlives the Charge). The rule text does not support it: the sentence sits inside the Charge action's own paragraph, the corpus contains it 13 times and never once with a duration clause, and every printed exemption is phrased as a Charge-move exemption ("...can leave that operative's control range to do so", "...when performing the Charge action"). Under the within-move reading the field itself becomes unnecessary, which is an owner call because 13 team modules write it today.

### Evidence (run, not read)

Scratch file /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/w18.test.ts, run with the scratch config. Charger p1-0 at (10,11) on 32mm bases, unscreened enemy A=p2-0 at (12.5,12.6), target B=p2-1 at (18,11), friendly mate parked at (4,4). Charge declared to (15.8,11):

  start gap charger-A 1.708 engaged? false          <- not engaged at start
  mid  gap to A 0.340 engagedA mid? true            <- clipped en route
  end  gap to A 2.408 engagedA? false               <- has LEFT A's control range
  end  gap to B 0.940 engagedB? true
  validateMove ok= true reason= undefined total= 6 budget= 8
  rejected= []
  charger pos after = {"x":15.8,"y":11}
  stickyEngagedWith = ["p2-1"]  (A= p2-0  B= p2-1 )

The illegal Charge is ACCEPTED and A is never recorded. The control case in the same file puts the mate at (12.5,14.4) — inControlRange(mate,A)=true, gap 0.540 — and the same Charge is correctly accepted.

Third test in the same file proves the flag is inert: after a Charge onto a lone B, sticky=['p2-1']; in the next activation `Fall Back` straight o …[truncated]

### Plan

Derive the sticky set from the path sampling that already exists, and enforce it as an END-OF-MOVE requirement of the Charge.

1. src/core/movement.ts, `enemyOnTheWay` (line 353). Add a ninth parameter `sticky?: Set<string>`. Replace the early-out at line 396 (`if (opts.mayEnterEnemyControlRange) continue;`) with:
     const trackOnly = opts.mayEnterEnemyControlRange === true;
     if (trackOnly && !sticky) continue;              // Fall Back etc: nothing to record
   and leave the next four statements exactly as they are (line 403 `if (startedEngaged(enemy)) break;`, the lazy `index ??= terrain(...)`, the `withinControlRange` probe, and the `screened` computation at line 411). Then change the terminal statement at line 415 to:
     if (trackOnly) { sticky!.add(enemy.id); break; }
     return `cannot move within control range of ${enemy.letter}`;
   `startedEngaged` must stay above the record because "if it MOVES WITHIN control range" excludes an enemy it was already within control range of (D-072); `screened` must stay because the rule says "that no other friendly operatives are within control range of", measured pre-move per D-072. `break` after adding: one entry per enemy is all the set needs.

2. src/core/movement.ts, `validateMove` (line ~108). Before the waypoint loop add `const sticky = opts.mustFinishEngaged ? new Set<string>() : undefined;` and pass it as the last argument at line 273. Gate on `mustFinishEngaged`, not on `mayEnterEnemyControlRange`, because Fall Back also sets the latter and carries no sticky clause.

3. src/core/movement.ts, after the existing engagedAtEnd/mustFinishEngaged block (lines 302-310) and BEFORE the budget check at line 312:
     if (sticky && sticky.size > 0) {
       const moved = { ...op, pos: cur, z: finalZ };
       const endState = { ...state, operatives: { ...state.operatives, [op.id]: moved } };
       for (const id of sticky) {
         const e = state.operatives[id];
         if (!e || e.removed) continue;
         if (!inControlRange(ctx, endState, moved, e))
           return fail(`a Charge cannot leave the control range of ${e.letter}, which no other friendly operative is within control range of`);
       }
     }
   Reuse the same `{...state, operatives:{...}}` shape line 302 uses so the two agree about "within control range at the end".

4. src/core/movement.ts, `MoveValidation` (line ~49): add `sticky?: string[]`, populated on the success return at line 317 as `sticky ? [...sticky] : undefined`.

5. src/core/movement.ts, `enemyProbes` (line ~433): leave the `if (opts.mayMoveThroughEnemies && opts.mayEnterEnemyControlRange) return [];` early-out alone. It is already right for the two printed rules that grant both permissions together (Blades of Khaine Aspect Techniques, Brood Brother PSYCHIC FAMILIAR Elusive: "can move through enemy operatives, move within control range of them, and during the Charge action can leave their control range"). Add a comment so it is not read as an oversight.

6. src/core/actions.ts, `applyMove` (line 139): return type becomes `{ ok: boolean; reason?: string; sticky?: string[] }`, returning `v.sticky` on success.

7. src/core/actions.ts, Charge `perform` (lines 296-314): delete the end-of-move recomputation at 309-312, replace with `op.stickyEngagedWith = r.sticky ?? [];`. This also fixes a second inconsistency — the current filter measures "no other friendly operatives are within control range of" AFTER the move, while enemyOnTheWay measures it before.

8. Per-enemy exemption seam (CLAUDE.md rule 5: Gellerpox MUTOID VERMIN prints a TARGET-side exemption). Add hook name `onChargeSticky` to HOOK_NAMES in src/core/hooks.ts with event `{ state; operative; enemy; sticky: boolean }`; emit it in enemyOnTheWay at the moment an id is about to be added, once per enemy, and skip the add when `ev.sticky === false`. Register the handler in src/teams/gellerpox-infected/index.ts and delete that clause from its REMINDER_ONLY list (index.ts:205). Do NOT add handlers for the other five printed exemptions — Angel of Death Chapter Tactics, Gellerpox RUST EMANATIONS and BARGE, Raveners TUNNEL LURKERS and SLITHERING EVASION are all "can perform the Charge while ALREADY within control range ... and can leave that operative's control range to do so", which `startedEngaged(enemy) break` already covers.

9. src/ai/moves.ts needs no change (buildPath drops anything validateMove rejects). Only if the soak shows the AI losing charges it should keep, add one more attempt for action==='Charge': a two-leg path via the nearest point on the clipped enemy's control-range ring. Measure first.

10. Team modules that write stickyEngagedWith after their own path-validated Charge — goremonger:1941, warpcoven:1696, murderwing:273, canoptek-circle:1823, chaos-cult:2182, corsair-voidscarred:1542, farstalker-kinband:682 and :1651, sanctifiers:1461, hearthkyn-salvager:1860 — should read `v.sticky ?? []` from their own validateMove result. The FLY/teleport writers (vespid-stingwings:530, hearthkyn-salvager:1756, murderwing:919) have no path; leave them with the end-position computation and say why in a comment.

### Verifier objection — takes precedence over the plan above

LIVE — confirmed by my own run of the investigator's /tmp/.../scratchpad/w18.test.ts: `validateMove ok=true`, charger lands at (15.8,11), `stickyEngagedWith=["p2-1"]`, A (p2-0) never recorded, and a later clean Fall Back off the sticky enemy is accepted with the flag unchanged. `grep -rn stickyEngagedWith src/` = 14 writes + 1 initialiser (reducer.ts:140) + 1 type (types.ts:332) + 1 comment (gellerpox-infected/index.ts:205), zero reads. Rule reading (within-the-move, not persistent) is correct: 13 occurrences of the sentence across 12 corpus files (core-rules.txt:285 and :721 plus 11 others), never with a duration clause. No DECISIONS.md entry covers charge stickiness.

But the PLAN is not sound. I built the plan verbatim (steps 1-5) into /tmp/.../scratchpad/w18v/movement.patched.ts and ran it (/tmp/.../scratchpad/w18v/verify.test.ts). Baselines pass — the plain clip-and-leave Charge is now rejected ("a Charge cannot leave the control range of A…") and the screened case still validates ok with sticky=["p2-1"]. Two holes are proved:

(1) STEP 5 IS WRONG, AND ITS JUSTIFICATION IS FALSE. With `{...CHARGE, mayMoveThroughEnemies:true}` (Gellerpox BARGE) the patched code returns `ok=true, sticky=[]` — `enemyProbes` (movement.ts:433) early-outs `if (opts.mayMoveThroughEnemies && opts.mayEnterEnemyControlRange) return []`, and `enemyOnTheWay` then exits at `if (probes.length === 0) return undefined`, so no id is ever collected and the whole new rule is bypassed. The plan tells the implementer to LEAVE that early-out and add a comment blessing it, citing "Blades of Khaine Aspect Techniques" and "Brood Brother PSYCHIC FAMILIAR Elusive". Neither exists as described: `grep -rn mayMoveThroughEnemies src/` finds exactly ONE emitter, gellerpox-infected/index.ts:1573-1578 (BARGE); blades-of-khaine/index.ts:791-794 (PATIENT STALK) sets only `mayEnterEnemyControlRange` and is a Reposition; brood-brother PSYCHIC FAMILIAR Elusive is REMINDER_ONLY (index.ts:990, :1716 — "onMoveRules … declared but never emitted"). docs/DECISIONS.md D-072 names the same two real rules (BARGE and PATIENT STALK/SUDDEN BLOW). And BARGE's own printed text (data/teams/gellerpox-infected.json, firefight ploy BARGE) refutes the exemption: "It can perform the Charge and Reposition actions while within control range of an enemy operative, and can leave that operative's control range to do so (but then normal requirements for that move apply)." The leave permission is scoped to the enemy it STARTED engaged with — already covered by `startedEngaged(enemy) break` — and the parenthetical explicitly preserves everything else.

(2) STEP 3 UNDER-ENFORCES THE RULE. "it cannot leave that operative's control range" is a constraint on the whole move; an end-of-move membership test only catches never-returned. Proved: A at (12.5,12.9), path (10,11)→(12.5,11)→(12.5,10.4)→(12.5,11.2). Console: `wp1 in A CR? true | wp2 (LEFT) in A CR? false | end back in A CR? true`, and the patched validateMove returns `ok=true, sticky=["p2-0"], total=5 budget=8`. This is reachable in AI play, not just from the UI: `buildPath` (src/ai/moves.ts:236-248) submits four multi-leg candidates for a Charge (routed path, mid-point dog-leg, two perpendicular dog-legs).

(3) Smaller: the `onChargeSticky` hook in step 8 is emitted from inside `validateMove`, which the AI runs thousands of times per decision — the plan should cite the existing `onMovePermissions` precedent (movement.ts:336) and require handlers to be side-effect-free, or the purity/performance claim is unbacked. And I did NOT re-run the 108-game instrumented soak, so "1 illegal Charge in 108 games" is unverified by me.

What I checked and found CORRECT: the `mustFinishEngaged` gate is safe — all 20 team uses (kommandos:97, brood-brother:2181, nemesis-claw:1082, hernkyn-yaegir:1367, inquisitorial-agent:1503, wyrmblade:1459 …) are Charge-shaped, and Fall Back sets only `mayEnterEnemyControlRange`; `buildPath` really does drop anything validateMove rejects (its own comment: "so a move intent can never be rejected"), so the audit's rejected-intent risk is indeed impossible.

### Corrected plan

Keep steps 1-4, 6, 7, 9, 10 as written. Replace step 5: `enemyProbes` must NOT early-out when the caller needs sticky tracking — change the guard to `if (opts.mayMoveThroughEnemies && opts.mayEnterEnemyControlRange && !opts.mustFinishEngaged) return [];`, so a BARGE Charge still walks the per-enemy loop (the base-overlap test inside it is already skipped by `!opts.mayMoveThroughEnemies`). Justify it with BARGE's own sentence "(but then normal requirements for that move apply)" from data/teams/gellerpox-infected.json, and with D-072, not with Blades of Khaine or the Brood Brother familiar. Add a test: a BARGE-flagged Charge that clips an unscreened third enemy and finishes elsewhere is rejected, while the same operative leaving the control range of the enemy it STARTED engaged with is accepted.

Replace step 3's end-of-move loop with a during-the-move test, which is both stricter and correct: in `enemyOnTheWay`, do not `break` after `sticky.add(enemy.id)` on the increment that adds it; instead record it and, on every subsequent sample for that enemy (this increment and later ones, since the Set persists across the waypoint loop), fail with `cannot leave the control range of ${enemy.letter}` the first time `withinControlRange(index, here, eBody)` is false. Keep the end-of-move test as a cheap backstop for the final position only. If the owner prefers to keep the cheap approximation for performance, say so explicitly in DECISIONS.md as an accepted under-enforcement with the leave-and-return case named — do not ship it silently.

Add to the owner question: the plan's step 4/7 still leave `stickyEngagedWith` written and never read under the recommended within-move reading; decide delete-vs-diagnostic in the SAME change, not later.

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

### OWNER

Yes, and not covered by any existing entry — docs/DECISIONS.md has nothing mentioning Charge stickiness (D-050, D-072, D-081 and D-102 cover the neighbouring movement work and none touch this).

The question: does "it cannot leave that operative's control range" bind only the Charge move, or persist afterwards?
For within-the-move (my recommendation): the sentence lives inside the Charge paragraph; the corpus carries it 13 times with no duration clause; every printed exemption is Charge-scoped ("...to do so", "...when performing the Charge action"); and the persistent reading would make Fall Back — the action whose whole purpose is disengaging — illegal against a solo charge target for the rest of the battle.
Against: the codebase assumed persistence. src/core/types.ts:332 calls it "Set while the operative is in a Charge that made it the sole engager", and five team modules deliberately CLEAR it on teleport / go-underground / free Fall Back (tempestus-aquilons:306, raveners:475, void-dancer-troupe:869, corsair-voidscarred:1312, murderwing:952), which only makes sense if something were meant to read it later.

The owner must also say what happens to the field. Under the within-move reading `op.stickyEngagedWith` has no consumer: either delete it (with the 13 writes and 5 clears) or keep it as a logged diagnostic with a comment saying it is not a rule input. Leaving it written-and-unread is the silent no-op CLAUDE.md rule 5 forbids, and gellerpox-infected/index.ts:205 already says so out loud.

### Files

`src/core/movement.ts`, `src/core/actions.ts`, `src/core/hooks.ts`, `src/teams/gellerpox-infected/index.ts`, `src/teams/goremonger/index.ts`, `src/teams/warpcoven/index.ts`, `src/teams/murderwing/index.ts`, `src/teams/canoptek-circle/index.ts`, `src/teams/chaos-cult/index.ts`, `src/teams/corsair-voidscarred/index.ts`, `src/teams/farstalker-kinband/index.ts`, `src/teams/sanctifiers/index.ts`, `src/teams/hearthkyn-salvager/index.ts`, `tests/rules-review.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`


---

## W-21

*Effort: medium · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

```
docs/rules-source/core-rules.txt:374-379, the Fight sequence, verbatim:
  374: "1. Select Enemy Operative"
  375: "The attacker selects an enemy operative within the active operative's control range to fight against. That enemy operative will retaliate in this action."
  376: "2. Select Weapons"
  377: "Both players select one melee weapon () to use that their operative has and collect their attack dice — a number of D6 equal to the weapon's Atk stat."
  379: "If a rule says an operative cannot retaliate, then they can still be fought against, but attack dice cannot be collected or resolved for them."
Line 377 is unambiguous that the selection belongs to BOTH players and that the selected weapon's Atk sets the pool size; line 379 is the only carve-out and is already honoured by seq.defenderCanRetaliate.
```

### Where the original entry is wrong

The headline is right — the defender still gets no choice — but six specifics are wrong.

(1) THE FLAGSHIP EXAMPLE IS DISPROVED. "A Blooded Traitor Chieftain always retaliates with its Bayonet" is false in any game where a loadout was selected. data/teams/blooded.json gives the CHIEFTAIN four loadout options — "Autopistol or laspistol; chainsword or power weapon" / "Bolt pistol; chainsword" / "Boltgun; bayonet" / "Plasma pistol; improvised blade" — each with exactly ONE melee weapon. Run through tests/teams/harness.ts (which calls applyLoadouts) `weaponsOf(ctx,s,chief,'melee')` returns a single weapon, Chainsword, and there is nothing to choose.

(2) "64 of 454" is EXACTLY reproducible but is a raw card-order count. Over data/teams/*.json: 454 datacards; 64 have more than one melee PROFILE available in card order (59 have >1 melee WEAPON; 5 more have one weapon with two melee profiles). That 64 IS the live figure for AI-driven and soak games, because nothing outside the UI records a loadout: applyLoadouts is called only from src/ui/App.tsx:305, src/ui/flow/Setup.tsx:144 and tests/teams/harness.ts:99 — the reducer's SelectRoster (src/core/reducer.ts:112-150) stores no weapons and src/ai/runner.ts:93 dispatches SelectRoster and stops. src/teams/blades-of-khaine/index.ts:466 already says "an AI-driven game never calls applyLoadouts". With a validated loadout the count collapses to 17 datacards that certainly keep >1 melee profile (blooded Traitor Corpseman; brood-brother Magus and Medic; celestian-insidiants Insidiant Abjuror; deathwatch Blademaster Veteran; exodite-dragon-masters Clanblade, Leystalker, Stonesinger; gellerpox-infected Bloatspawn and Fleshscreamer; inquisitorial-agent Death World Veteran Agent; sanctifiers Miraculist and Missionary; warpcoven Sorcerers of Destiny, Tempyrion and Warpfire; wrecka-krew Breaka Boy Demolisha), rising to 26 if entries carrying BOTH a `loadouts` row and `optionGroups` really allow both. At least one of those nine looks like a scrape artefact: angel-of-death Assault Intercessor Sergeant has loadouts=["Plasma pistol; chainsword"] AND optionGroups for a pistol and a melee weapon, so combining them yields Hand flamer + Plasma pistol + Chainsword + Power fist.

(3) "no code anywhere writes seq.defenderWeapon" is FALSE at HEAD. src/teams/pathfinders/index.ts:583 (POINT-BLANK FUSILLADE) writes `seq.defenderWeapon = melee.name` and `seq.defenderCanRetaliate = true`. An override rather than a choice, but the field is a live, exercised seam.

(4) "there is no decision kind" is accurate but implies more work than exists: PendingDecision.kind is a plain `string` (src/core/types.ts), so no union needs widening, and resolveDecision's switch (src/core/decisions.ts:38) already has a `default` arm walking ctx.decisionHandlers.

(5) "adds a screen to the UI flow ... a branch in commandPlan / src/ui/command/play.tsx" is FALSE. src/ui/command/index.tsx:116-117 routes ANY state.pending[0] to decisionPlan, which renders prompt + options generically, with a handover gate and a sourceText tooltip. The only worthwhile UI change is one line in DECISION_LABEL (index.tsx:34-45), and even that has a camelCase fallback at :47-48. play.tsx needs nothing.

(6) The suggested "cheap interim (default to the highest-Atk melee profile)" is not cheaper where it counts: either way the defender's Atk changes, so the same seeded fixtures drift. Its only saving is the AI/UI plumbing.

### Evidence (run, not read)

Scratch file /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/w21b.test.ts. A real Brood Brother Magus fielded through tests/teams/harness.ts `battle()` (which DOES apply the validated loadout), fought by a p1 operative:

  magus recorded loadout: ["Autopistol","Bio dagger","Force stave"]
  magus available melee: [ 'Bio dagger A2 H4 3/6', 'Force stave A4 H4 4/6' ]
  startFight {"ok":true}
  defenderWeapon = Bio dagger
  defender profile: atk 2 hit 4 dmg 3/6
  pending after startFight: []
  pending after advanceFight: [ 'reroll/p1' ]
  defender pool size: 2
  attacker pool size: 4

A legally fielded operative owning a 4-dice Force stave retaliates with a 2-dice Bio dagger, forever, and no weapon decision is offered — the only pending decision is the attacker's reroll. Both `seq.defenderWeapon === 'Bio dagger'` and `!state.pending.some(p => /weapon/i.test(p.kind))` hold.

Chieftain counter-evidence, /tmp/.../scratchpad/w21.test.ts:
  chieftain available melee weapons: [ 'Chainsword[melee A4 H3 4/5]' ]
  seq.defenderWeapon = Chainsword  defenderP …[truncated]

### Plan

Add a defender-owned 'Select Weapons' step. Smaller than the audit implies because PendingDecision.kind is free-form and the UI renders decisions generically.

1. src/core/sequences/types.ts, `FightStep` (line 60): insert `'selectWeapons'` between `'start'` and `'rollAttack'`. Add `weaponChoiceMade?: boolean` to FightSequence beside `usedRetention`.

2. src/core/sequences/fight.ts, `startFight` (line 44). Keep the default assignment at lines 63-64 exactly as is — it makes the sequence readable before the choice is answered, it is what pathfinders' POINT-BLANK FUSILLADE overrides, and it is the input to `defenderCanRetaliate`. Replace the stale comment at 61-62 with one naming the new step. Export a shared helper:
     export function meleeOptionsFor(ctx, state, op): { weaponName: string; profileName?: string; profile: WeaponProfile }[]
   built from `weaponsOf(ctx, state, op, 'melee')` flat-mapped over `w.profiles.filter(p => p.type === 'melee')`. weaponsOf already folds the availableWeapons hook, grantedWeapons and Limited-x exhaustion, so a spent Limited weapon never appears and a granted one does.

3. src/core/sequences/fight.ts, `advanceFight` (line 127). `case 'start':` (line 135) now sets `seq.step = 'selectWeapons'`. Add:
     case 'selectWeapons': {
       const opts = seq.defenderCanRetaliate ? meleeOptionsFor(ctx, state, defender) : [];
       if (!seq.weaponChoiceMade && opts.length > 1) {
         seq.weaponChoiceMade = true;            // set BEFORE the push, exactly as usedRetention does at line 180
         push(state, {
           id: `fweapon-${state.seq++}`,
           who: seq.defender,
           kind: 'selectRetaliationWeapon',
           prompt: `${defender.letter} selects a melee weapon to retaliate with`,
           options: opts.map(o => ({
             id: `${o.weaponName}|${o.profileName ?? ''}`,
             label: `${o.weaponName}${o.profileName ? ` (${o.profileName})` : ''} — A${o.profile.atk} ${hitOf(ctx, state, defender, o.profile, seq.defenderAssists)}+ ${o.profile.dmgN}/${o.profile.dmgC}`,
             data: { weaponName: o.weaponName, ...(o.profileName ? { profileName: o.profileName } : {}) },
           })),
           sourceText: "Both players select one melee weapon to use that their operative has and collect their attack dice — a number of D6 equal to the weapon's Atk stat.",
         });
         return;
       }
       seq.step = 'rollAttack';
       break;
     }
   Not optional: the rule requires a selection. The flag before the push stops the while-loop at line 128 re-offering.

4. src/core/decisions.ts, resolveDecision switch (line 38):
     case 'selectRetaliationWeapon': {
       const seq = state.sequence as FightSequence | undefined;
       if (seq?.kind === 'fight') {
         if (typeof payload['weaponName'] === 'string') seq.defenderWeapon = payload['weaponName'];
         if (typeof payload['profileName'] === 'string') seq.defenderProfile = payload['profileName'];
         else delete seq.defenderProfile;
         seq.step = 'rollAttack';
       }
       break;
     }
   The tail of resolveDecision (line 111) already calls advanceFight, so nothing else resumes it.

5. src/core/decisions.ts, `defaultDecisionOption` (line 219): add a dumb deterministic arm — highest Atk, ties broken by option order — so auto-resolve never stalls. The real policy lives in the AI.

6. src/ai/decide.ts, `decideOption` (line 35): add `case 'selectRetaliationWeapon': return chooseRetaliationWeapon(ctx, state, decision) ?? fallback();`. `sideWeapon` is already imported at line 15 and src/ai/combat.ts already scores a melee exchange; score each option by expected unblocked damage against the attacker's Save and weapon. Explicitly penalise a profile carrying Limited — Sanctifier Miraculist's Burning hands is Limited 1 / A1 H2 7/8 Brutal and a naive maximiser will burn its one use retaliating.

7. src/ui/command/index.tsx: add `selectRetaliationWeapon: 'Retaliation weapon'` to DECISION_LABEL (lines 34-45). No other UI change.

8. Fix the stale comment in fight.ts and drop any team REMINDER_ONLY entry saying the retaliation weapon cannot be chosen.

### Verifier objection — takes precedence over the plan above

LIVE — I re-ran /tmp/.../scratchpad/w21b.test.ts myself: a Brood Brother Magus fielded through tests/teams/harness.ts (which does call `applyLoadouts`, at harness.ts:100) with the validated loadout ["Autopistol","Bio dagger","Force stave"] retaliates with the Bio dagger (A2) and never the Force stave (A4); `pending after startFight: []`, defender pool 2 dice, the only decision raised is the attacker's reroll. src/core/sequences/fight.ts:63 `const dw = weaponsOf(ctx, state, defender, 'melee')[0];` with the stale comment above it. Rule quote checked verbatim at core-rules.txt:374-379.

I independently reproduced the counts and they are EXACT: 454 datacards, 59 with >1 melee weapon, 64 with >1 melee profile. `applyLoadouts` call sites: src/ui/App.tsx:305, src/ui/flow/Setup.tsx:144, tests/teams/harness.ts:100 (+ one team test) — confirmed, so AI games really do field every printed weapon. UI claim confirmed: src/ui/command/index.tsx:115-117 routes any `state.pending[0]` to `decisionPlan`, DECISION_LABEL is a plain Record with a de-camel-case fallback at :47-48. `who: seq.defender` is correct — fight.ts:84-85 sets `attacker: attacker.player, defender: defender.player` (player ids), while `attackerId`/`defenderId` are operative ids. My initial suspicion that the plan passed an operative id was wrong.

Three defects in the plan:

(1) STEP 2's `meleeOptionsFor` OFFERS EXHAUSTED PROFILES. `weaponsOf` (src/core/state.ts:255-257) drops a weapon only when `w.profiles.every(p => weaponExhausted(op, w, p))`. The plan then flat-maps over `w.profiles.filter(p => p.type === 'melee')` with no per-profile check. Wrecka Krew Breaka Boy Demolisha's Tankhammer (data/teams/wrecka-krew.json) has exactly this shape — profile "bash" (A4 H3 4/5, no rules) and profile "detonate" (A4 H3 0/0, Lethal 5+, Limited 1, Detonate) — so after Detonate is spent the plan still offers it. This directly contradicts the plan's own testPlan bullet "a Limited profile already exhausted is not offered" (whose Brood Brother Medic case only works because there the two profiles sit on two different WEAPONS).

(2) STEP 5 IS NOT IMPLEMENTABLE AS STATED. `defaultDecisionOption(decision)` (src/core/decisions.ts:219) takes only the `PendingDecision` — no ctx, no state — so "highest Atk, ties by option order" cannot be computed from `{id, label, data:{weaponName, profileName}}` without string-parsing the label.

(3) THE PROMISED POINT-BLANK FUSILLADE REGRESSION CANNOT PASS AS DESIGNED, and the seam is overstated. src/teams/pathfinders/index.ts:566-588 fires on `onPloyUsed` and requires a live fight sequence, but today `advanceFight`'s `case 'start'` (fight.ts:135-137) falls straight through to 'rollAttack' with no pending window, so the ploy is unreachable in real play — its only exerciser is tests/teams/pathfinders.test.ts:422-445, which HAND-BUILDS a sequence at step 'start' and never calls advanceFight. Calling the field "a live, exercised seam" overstates that. Worse, the plan's new 'selectWeapons' step is the first real window the ploy could use, and it breaks it: the options array is snapshotted before `grantWeapon` adds the "(point-blank)" weapon, and `resolveDecision` then overwrites `seq.defenderWeapon` from the chosen option — so the ploy's write loses, and the AI/default (highest Atk) will not pick it.

### Corrected plan

Step 2: filter profiles with the already-exported `weaponExhausted(op, w, p)` (src/core/state.ts:278) as well as relying on `weaponsOf`'s weapon-level filter — `w.profiles.filter(p => p.type === 'melee' && !weaponExhausted(op, w, p))`. Keep the Brood Brother Medic test AND add a Breaka Boy Demolisha test that spends Detonate and asserts only "bash" is offered on the next retaliation.

Step 5: put the numbers in the option payload — `data: { weaponName, profileName?, atk, dmgN, dmgC }` — so `defaultDecisionOption` can pick `max(Number(o.data?.atk ?? 0))` with ties by array order, and so the AI arm in step 6 does not have to re-derive them either.

Step 3: do not raise the decision blind. Add `seq.defenderWeaponForced?: boolean`, set it wherever a rule writes `seq.defenderWeapon` (pathfinders/index.ts:583 today), and skip the selectWeapons decision when it is set. Alternatively re-derive `meleeOptionsFor` inside the `case 'selectRetaliationWeapon'` arm of `resolveDecision` and reject an option that is no longer available — but the forced-flag is simpler and is what the plan's own regression bullet actually needs. Also fix the plan's characterisation: POINT-BLANK FUSILLADE is currently unreachable in a real game, so its "regression" test is really a first-time enablement and should say so.

Everything else in the plan stands. Do NOT use the Blooded Traitor Chieftain as the positive fixture (its loadout leaves one melee weapon — the audit's example is genuinely disproved); the Brood Brother Magus is the right one. Owner question 2 (should the AI/soak path record loadouts) is the one that actually sizes this item and should be answered before the fixture re-baseline is paid.

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

### OWNER

Yes — three questions, none covered by an existing entry. docs/DECISIONS.md has no decision about retaliation weapons; the nearest precedent is D-022 ("'You can use this rule' is auto-used on a stated, deterministic policy when it is free, and raised as a PendingDecision when it costs something").

1. Full blocking decision (rules-faithful — core-rules.txt:377 makes it a player choice) or a deterministic best-profile default under D-022? For the decision: the choice genuinely costs something in at least three fielded cases — Sanctifier Miraculist's Burning hands is Limited 1, Deathwatch Blademaster Veteran's second Xenophase blade profile is a Phase Sweep mode, Wrecka Krew Breaka Boy Demolisha's second Tankhammer profile is a 0/0 Limited-1 Detonate. A blind maximiser burns all three. Against: one extra reactive window per multi-melee fight. Note the "cheap interim" is not cheaper in fixture cost — both options change the dice count identically.

2. The one that actually sizes this item: should the AI/soak path record loadouts? Today src/ai/runner.ts:93 dispatches SelectRoster and never calls applyLoadouts, so AI games field operatives carrying every weapon printed on the card — which is what inflates this from 17 datacards to 64, and is a rules problem in its own right (an operative fighting with a weapon it did not select). I could not find it filed anywhere. If the owner wants it fixed, do it BEFORE or WITH W-21, or the fixture re-baseline is paid twice.

3. Data, low stakes: should a selection entry combine a `loadouts` row with `optionGroups`? angel-of-death Assault Intercessor Sergeant currently yields Hand flamer + Plasma pistol + Chainsword + Power fist that way. If that is a scrape bug it belongs in tools/teams, and the fieldable count drops from 26 to 17.

### Files

`src/core/sequences/types.ts`, `src/core/sequences/fight.ts`, `src/core/decisions.ts`, `src/ai/decide.ts`, `src/ui/command/index.tsx`, `tests/rules-review.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`


---

## W-22

*Effort: medium · verifier agrees it is live: False · verifier accepts the plan: False*

### Rule

```
docs/rules-source/universal-equipment.txt:100 - "Razor wire is Exposed and Obstructing terrain. Before the battle, you can set it up wholly within your territory, on the killzone floor and more than 2\" from other equipment terrain features, access points and Accessible terrain."
docs/rules-source/universal-equipment.txt:102 - "Obstructing: Whenever an operative would cross over this terrain feature within 1\" of it, treat the distance as an additional 1\"."
docs/rules-source/killzones.txt:160 - "Operatives cannot move through terrain - they must move around, climb over or drop/jump off it."
docs/rules-source/killzones.txt:165 - "Operatives must finish a move in a location they can be placed - they cannot finish midway through a climb, drop or jump. If this isn't possible, they cannot begin the move."
The decisive reading: a rule that PRICES crossing ("treat the distance as an additional 1\"") presupposes that crossing is legal. Razor wire carries no size type (it is neither Light nor Heavy) - Obstructing is its whole movement rule, and it supersedes the general killzones.txt:160 prohibition for this feature. killzones.txt:165 is what keeps `solid` true: you may cross the wire but you may not end your move standing in it.
```

### Where the original entry is wrong

Substantially accurate, three corrections. (1) LINE NUMBERS HAVE MOVED: the surcharge is now computed at src/core/movement.ts:224-226 (audit says 192) and pathBlockedByTerrain is called at src/core/movement.ts:253 with a Wall check in between (audit says 'three statements later'). kit.ts:145 `solid: !insignificant` is still exactly right. (2) THE HEADLINE IS SLIGHTLY OVERSTATED: 'the wire cannot be crossed at all' is false in the strict sense - a hand-authored 3-leg path with explicit `zs` that CLIMBS onto the wire's 1.417in top, walks across and drops off IS accepted (proved: ok:true, total 6in of a 6in Move: 1 + 2 climb + 2 across (incl. the +1in surcharge) + 0 drop + 1). It is unreachable in practice, though: `surfacesAt` on the wire returns [0] because the part is not standable, so `reachableCells` - the flood fill behind both the AI and the board's move preview - never puts a node on it (proved: 0 reached cells above the floor, and 0 reached cells at y=11 with x>=9 on a 6in budget). And `noClimb` actions can never do it ('Dash cannot climb'). So the correct statement is: the wire cannot be crossed horizontally by anything, cannot be crossed at all by a Dash, and cannot be crossed by any path the shipped path builder can produce. (3) THE AUDIT'S FIRST-CHOICE FIX IS WRONG. It offers `solid: false` in buildEquipmentFeature OR a skip in pathBlockedByTerrain as equivalent. They are not: I simulated `solid:false` and the straight cross does become legal at 5in, but an operative may then FINISH standing in the middle of the razor wire (proved: Reposition to (8,11) accepted, 3in), which breaks killzones.txt:165 'Operatives must finish a move in a location they can be placed'. `solid:false` also removes the part from `index.solid`, and src/teams/wyrmblade/index.ts:402 and src/teams/hernkyn-yaegir/index.ts:305 build their own placement-zone polygon sets from `part.solid !== false`, so their zones would silently open up over razor wire. Take the pathBlockedByTerrain skip only. Two defects the audit missed: obstructingCrossings has NO z filter (an operative on a 3in Vantage gantry directly above the wire is charged the extra inch), and `extra = (obstructing.length > 0 ? 1 : 0)` charges +1in whether one or two wires are crossed (the same open half of W-19, which was fixed via D-077's standingOn skip-set and never got the strict-crossing predicate the audit proposed).

### Evidence (run, not read)

Scratch files: /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/equip-w22-w23.test.ts, equip2.test.ts, equip3.test.ts, equip4.test.ts, equip5.test.ts. Run with `cd /home/user/kill-team-mobile && npx vitest run --config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vitest.scratch.config.ts <file>`. All pass (they log rather than assert, except the fix simulation).

(1) THE PART AS BUILT - razor wire placed at (8,11) rot 90 on tests/fixtures.ts testMap:
  RAZOR PARTS [{ id: 'equip.p1.eq.razorWire.0.body', types: ['Exposed','Obstructing'], z0: 0, z1: 1.4173228346456694, solid: true, blocksVisibility: false, poly: x 7.8031..8.1969, y 9.5827..12.4173 }]
  IN index.solid? true

(2) THE STRAIGHT CROSS IS REJECTED, SURCHARGE COMPUTED AND THROWN AWAY - operative (32mm, Move 6) at (6,11), Reposition to (10,11):
  CROSS validateMove => {"ok":false,"reason":"cannot move through equipment (Exposed+Obstructing)","total":5,"legs":[{"k":"horizontal","raw":4,"ch":5,"note":"+1\" terrain"}]}
  CROSS reducer => {"ok":fa …[truncated]

### Plan

THREE CHANGES, all in src/core. Keep `solid: true` - do NOT touch src/core/equipment/kit.ts:145 and do NOT touch `defaultSolid` at src/core/terrain.ts:65 (both must keep the wire solid so `baseBlockedByTerrain` at src/core/terrain.ts:198-222 goes on refusing to let a base finish on it, and so wyrmblade/hernkyn-yaegir placement zones do not change).

1. src/core/terrain.ts, `pathBlockedByTerrain` (declared line 283). Insert one guard immediately after line 299 (`if (hasType(part, 'Insignificant')) continue;`) and before line 300's Ceiling guard:

    // Universal Equipment > Razor Wire: "Obstructing: Whenever an operative would cross over
    // this terrain feature within 1\" of it, treat the distance as an additional 1\"." A rule
    // that prices crossing presupposes crossing is legal; `obstructingCrossings` charges the
    // inch in validateMove. The part stays `solid`, so `baseBlockedByTerrain` still refuses to
    // let a move FINISH on it (killzones.txt:165).
    if (hasType(part, 'Obstructing')) continue;

   Extend the doc comment above `pathBlockedByTerrain` (lines 269-282), which enumerates the three exempt types, to name Obstructing as the fourth.

2. src/core/terrain.ts, `obstructingCrossings` (line 308). Replace the body to implement the "within 1in of it" clause and add the missing z filter. The wire polygon is always the 4-point rectangle from `rectPoly` (src/core/equipment/kit.ts:76-88), so its long axis is the segment joining the midpoints of its two SHORTEST edges. Charge when the increment crosses that axis LINE at a point within 1in of the polygon:

    /** The barrier line of an Obstructing part: the midpoints of its two shortest edges. */
    function obstructingAxis(poly: Poly): [Vec2, Vec2] { ... }   // pick the two shortest edges by length, return their midpoints

    export function obstructingCrossings(index: TerrainIndex, a: Vec2, b: Vec2, z: number): IndexedPart[] {
      return index.parts.filter((p) => {
        if (!hasType(p, 'Obstructing')) return false;
        if (p.z1 <= z + 1e-6 || p.z0 >= z + 1e-6) return false;      // we are above it or below it
        if (segmentCrossesPoly(a, b, p.poly)) return true;           // literally over the model
        const [m0, m1] = obstructingAxis(p.poly);
        const hit = segmentIntersectionPoint(a, b, m0, m1);          // where [a,b] meets the axis LINE (infinite in m0..m1)
        return hit !== null && distancePointToPoly(hit, p.poly) <= 1 + 1e-6;
      });
    }

   `distancePointToPoly` is already imported into terrain.ts (line 13). `segmentIntersectionPoint` does not exist - add it to src/core/geometry.ts next to `segmentsIntersect` (line ~250): solve the 2x2 for the segment [a,b] against the INFINITE line through (m0,m1), return the point iff the parameter along [a,b] is in [0,1]; return null when parallel. Do NOT change `segmentCrossesPoly` - W-19's risk note applies (15+ team-module callers depend on its permissive endpoint behaviour).

   Why this predicate and not the audit's 1in-inflated polygon: `segmentCrossesPoly` returns true whenever an endpoint is inside the polygon (geometry.ts:262), so an inflated rectangle would charge an operative that merely STARTS within 1in of the wire and walks directly away, and would charge a move running PARALLEL to the wire inside the band - neither of which "crosses over" anything. The axis test charges exactly the two cases the rule describes: over the model, or round an end within 1in of it.

3. src/core/movement.ts:224-225. Pass the level through and make the surcharge stack per part:

      const obstructing = obstructingCrossings(index, cur, next, curZ);
      const extra = (access.length > 0 ? 1 : 0) + obstructing.length;

   (The `obstructing.length` half is only reachable when both players take razor wire and one increment crosses both; keep it a separate, clearly-commented line so the owner can veto it independently - see the open half of W-19.)

Nothing in src/ui or src/ai needs touching: `reachableCells` (src/core/movement.ts:576-631) and `routePath` (648-695) both go through `pathBlockedByTerrain`, so the flood fill and the board's move preview start routing over the wire the moment change 1 lands.

### Verifier objection — takes precedence over the plan above

THE HEADLINE IS REFUTED BY THE CORPUS AND BY A RUN. Two independent failures.

(1) THE RULE IS MISREAD, and the corpus settles it. The investigator's "decisive reading" is: "a rule that PRICES crossing presupposes that crossing is legal". Compare the two pricing rules side by side:
  killzones.txt:222 (Accessible) — "Operatives CAN MOVE THROUGH Accessible terrain (THIS TAKES PRECEDENCE OVER Bases, and Terrain and Movement), but it counts as an additional 1\" to do so."
  universal-equipment.txt:102 (Obstructing) — "Whenever an operative would CROSS OVER this terrain feature within 1\" of it, treat the distance as an additional 1\"."
The drafters knew exactly how to grant move-through permission and to override killzones.txt:160, and did so explicitly for Accessible. Obstructing grants no permission and carries no precedence clause; it only prices. And "cross over" is the corpus's own word for the climb: killzones.txt:160 "they must move around, CLIMB OVER or drop/jump off it", killzones.txt:182 "moves up for 2\" … moves across 3\" until its base is fully past the terrain feature, then drops down for 0\"". `grep -rn Obstructing docs/rules-source/` returns exactly two lines (universal-equipment.txt:100 and :102) — there is no other definition. Razor wire is 36mm tall physical terrain with no size type; you climb it.

(2) THE RUN SHOWS THE ENGINE ALREADY DOES THIS, AND THAT RAZOR WIRE IS NOT SPECIAL. /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vfy-w22.test.ts, test A, ran the identical straight-cross and identical hand-built climb against razor wire, a LIGHT barricade and the HEAVY barricade:
  RAZOR WIRE   straight => ok:false 'cannot move through equipment (Exposed+Obstructing)'; CLIMB-OVER => ok:true total 6, legs [h 0.80->1, climb 2.00->2, h 0.80->2 [+1\" terrain], drop 1.42->0, h 0.80->1]
  LIGHT BARR.  straight => ok:false 'cannot move through equipment (Light)';            CLIMB-OVER => ok:true total 5
  HEAVY BARR.  straight => ok:false 'cannot move through equipment (Heavy)';            CLIMB-OVER => ok:true total 5
Razor wire behaves EXACTLY like every other solid equipment terrain feature. So:
  - "the wire cannot be crossed at all" is false — it is crossed by climbing over, which is what killzones.txt:160 prescribes;
  - "the Obstructing +1\" is computed and then thrown away" / "the toll is unreachable on any horizontal move" is FALSE — the toll is charged, on the across-the-top increment of the climb-over (the `+1\" terrain` note above, 0.8\" horizontal charged 2\");
  - the audit's "a 2.8\"-wide piece of equipment behaves as an impassable wall for the whole battle" is false: test C, an operative at (6,11) with a 6\" budget reaches 52 cells with x>=9, at every y from 6.5 to 15.5 except 11 — it simply walks round.
The investigator's own residual claim ("cannot be crossed by any path the shipped path builder can produce") is also not razor-wire-specific: `surfacesAt` returns [0] on top of the light barricade and the heavy barricade too, so the flood fill never climbs over ANY non-standable solid part. That is a real, general movement-planner defect — but it is not W-22, and W-22's proposed fix does not address it.

(3) THE PLAN'S CHANGE 1 WOULD BREAK THE RULES IT CLAIMS TO FIX. `if (hasType(part,'Obstructing')) continue;` in `pathBlockedByTerrain` makes razor wire the ONLY piece of solid equipment terrain an operative may walk straight through at ground level, for +1\". A 25mm light barricade would still demand a 2\" climb while 36mm razor wire — the thing whose flavour text calls it "a painful deterrent" — would cost one inch. That is backwards, and it deletes killzones.txt:160 for the one feature the corpus never exempted from it.

(4) THE PLAN'S OWN z FILTER DELETES THE ONLY SURCHARGE THAT IS LIVE TODAY. Change 2 proposes `if (p.z1 <= z + 1e-6 || p.z0 >= z + 1e-6) return false;`. On the legal climb-over the across increment runs at curZ === wire.z1 === 1.4173228346456694, so `p.z1 <= z + 1e-6` is TRUE and the part is filtered out (vfy-w22.test.ts test B logs exactly this, and logs that today `obstructingCrossings` returns 1 there). The plan would silently remove the +1\" from the only crossing the engine currently permits.

(5) MIS-STATED PRECEDENT. D-064 (docs/DECISIONS.md:71) already names `obstructingCrossings` and fixes the centre-line convention for exactly this test; the plan should cite it for the "within 1\"" measurement being centre-line, not base-edge.

WHAT IS ACTUALLY STILL LIVE (all proved, /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vfy-w22b.test.ts):
  a. The "within 1\" of it" clause is absent. Wire at (8,11) rot 90, poly y 9.583..12.417. A 4\" move at y=12.9 — 0.483\" past the end — is charged 4, crossings=0. Should be 5.
  b. No z filter at all: `obstructingCrossings.length === 3` (index,a,b). An operative on a Vantage gantry at z=3 directly over the wire moving 2\" is charged 3 with note `+1\" terrain`; the same 2\" away from the wire costs 2.
  c. `extra = (obstructing.length > 0 ? 1 : 0)` at src/core/movement.ts:225 charges +1\" whether one or two wires are crossed; the rule reads per feature.
  d. tests/equipment.test.ts:189 `expect(straight.total).toBe(5)` asserts a field of a validation that returned ok:false — it is a vacuous test that pins nothing.

### Corrected plan

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

### OWNER

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

*Effort: medium · verifier agrees it is live: True · verifier accepts the plan: True*

### Rule

```
docs/rules-source/universal-equipment.txt:138 - "A portable barricade is Light, Protective and Portable terrain, except the feet which are Insignificant and Exposed. Before the battle, you can set it up wholly within your territory, on the killzone floor and more than 2\" from other equipment terrain features, access points and Accessible terrain."
docs/rules-source/universal-equipment.txt:140 - "Protective: While an operative is in cover from this terrain feature, improve its Save stat by 1 (to a maximum of 2+)."
docs/rules-source/universal-equipment.txt:142 - "Portable: This terrain feature only provides cover while an operative is connected to it and if the shield is intervening (ignore its feet). Operatives connected to the inside of it can perform the following unique action during the battle."
Note the two loads: :142 gates COVER on connection, and :140 gates the SAVE BONUS on "in cover FROM THIS TERRAIN FEATURE" - not on being in cover generally. Both are unimplemented. Note also that neither sentence says "friendly": :142 says "an operative", :140 says "an operative". Only the unique action is scoped, to "Operatives connected to the INSIDE of it".
```

### Where the original entry is wrong

Accurate on the headline and the diagnosis; three corrections and two additions. CORRECT AS WRITTEN: the `types: ['Light','Protective','Portable']` assignment is still at src/core/equipment/portableBarricade.ts:36; `grep -rn "'Portable'" src/` still returns exactly two hits (that line and src/core/types.ts:63) plus the Board.tsx colour table; `connectedBarricade` (portableBarricade.ts:54-64) gates only the MOVE WITH BARRICADE action and is never consulted by cover; and the Conceal consequence is real - the target is dropped from `validTargets` entirely. CORRECTION 1: the free-cover window is NARROWER than the prose implies. Cover needs the part within 1in of the target's base (visibility.ts:366) and `connectedBarricade` needs <=0.25in, so the unearned-cover band is a base gap in (0.25in, 1.0in] - 0.75in wide. Beyond 1in the operative correctly gets nothing (measured: y=9.5 in, y=9.0 out). It is still a free cover save and a free Conceal immunity, but it is a 0.75in band, not 'anyone behind it'. CORRECTION 2: THE AUDIT'S PROPOSED SHAPE IS WRONG TWICE OVER. (a) 'Add a CoverOpts predicate' would miss the defect: `coverAndObscured` has 33 call sites and only 13 pass an opts object at all, so an opts-based gate leaves 20 team-module call sites ungated. The gate must be an inline `continue` in the coverParts loop - `coverAndObscured` already has target.pos/base/rot and the part, so it needs nothing from the caller. (b) 'reusing connectedBarricade's geometry' cannot be done by importing it: src/core/visibility.ts -> src/core/equipment/portableBarricade.ts -> src/core/movement.ts -> src/core/visibility.ts is a module cycle. `CONNECTED_INCHES` must move to a leaf module first. CORRECTION 3: 'Narrow the Protective hook to fire only when that same feature appears in cover.coverParts' is the right idea but is not currently possible - equipment modules are registered as `register(reg, player)` with NO GameContext (src/core/context.ts:125 passes ctx to teams but line 126 does not pass it to equipment), and `AttackContext` (src/core/hooks.ts:116-132) carries only a boolean `inCover`. The cover source has to be threaded through TargetCheck -> ShootSequence -> AttackContext. ADDITION 1 (missed by the audit): the Protective hook has NO friendly check on the defender - `ev.state.placedFeatures.find(f => ... f.owner === b.player)` picks WHICH barricade to look at, then measures against `ev.ctx.defender` whoever that is, so p1's barricade hands +1 Save to a p2 defender standing near it (proved). ADDITION 2 (missed by the audit): the hook fires when there is NO cover from the shield at all - I got mods.save === 1 with `coverAndObscured` returning inCover:false and coverParts:[], the operative unconnected, and the shield 1.34in away and off to one side. And the 1.5in test is base-centre-to-polygon-CENTROID, so it is base-size dependent (0.87in of edge slack on a 32mm base, 0.52in on a 50mm) and inconsistent with `connectedBarricade`'s base-edge-to-polygon <=0.25in. FINALLY, the audit's test plan asserts 'an ENEMY operative connected to it gets nothing' - that is NOT what the rule says ('while AN OPERATIVE is connected to it', not 'a friendly operative') and it is an owner decision, not a defect.

### Evidence (run, not read)

Scratch files: /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/equip-w22-w23.test.ts and equip2.test.ts. Run with `cd /home/user/kill-team-mobile && npx vitest run --config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vitest.scratch.config.ts <file>`.

(0) THE PART AS BUILT - barricade placed at (10,11) rot 0:
  body: id 'equip.p1.eq.portableBarricade.0.body', types ['Light','Protective','Portable'], z0 0, z1 1.5748, solid true, blocksVisibility true, poly x 9.6063..10.3937, y 10.8031..11.1969
  foot0/foot1: types ['Insignificant','Exposed'], z1 0.1575, solid false
So `hasType(part,'Portable')` is reachable on the body, and '(ignore its feet)' is ALREADY satisfied - `interveningParts` skips Exposed parts at src/core/visibility.ts:258, and every measured `coverParts` contained only `...0.body`.

(1) COVER WITHOUT CONNECTION - shooter p2-0 at (10,18), target p1-0 walked down the y axis (32mm base, r 0.63in):
  target y=10.55 connected=true  inCover=true  parts=["equip.p1.eq.portableBarricade.0.body"] …[truncated]

### Plan

FOUR CHANGES.

1. MOVE THE CONSTANT OUT OF THE CYCLE. src/core/visibility.ts cannot import src/core/equipment/portableBarricade.ts (that file imports `validateMove` from src/core/movement.ts, which imports src/core/visibility.ts). Move the declaration at src/core/equipment/portableBarricade.ts:29-30 into src/core/terrain.ts (a leaf - it imports only ./geometry.ts and ./types.ts), beside `hasType` at line 156:

    /** Universal Equipment > Portable Barricade: how close a base must be to the shield to
     *  count as "connected to it". */
    export const CONNECTED_INCHES = 0.25;

   In portableBarricade.ts replace the declaration with `export { CONNECTED_INCHES } from '../terrain.ts';` so tests/equipment.test.ts's import surface (via src/core/equipment/index.ts) is unchanged, and import it locally for `connectedBarricade`.

2. GATE COVER ON CONNECTION. src/core/visibility.ts, `coverAndObscured` (declared line 351), inside the `for (const part of inter.any)` loop at lines 364-373. The loop already computes the target's base distance to the part at line 366; add the Portable tightening immediately after it and before `coverParts.push(part)` at line 367:

      // Universal Equipment > Portable Barricade: "Portable: This terrain feature only provides
      // cover while an operative is connected to it and if the shield is intervening (ignore its
      // feet)." Cover belongs to the target, so the operative that must be connected is the
      // target. The feet are already excluded - they are Exposed, and `interveningParts` skips
      // Exposed parts.
      if (hasType(part, 'Portable') &&
          baseDistanceToPart(target.pos, target.base, target.rot, part) > CONNECTED_INCHES + 1e-6)
        continue;

   `hasType` and `baseDistanceToPart` are already imported (visibility.ts:27-35); add `CONNECTED_INCHES` to that same import block. Put the guard INLINE, not behind a `CoverOpts` flag: `coverAndObscured` has 33 call sites and only 13 pass opts, so an opts-based gate would leave 20 team-module call sites ungated.
   This one change fixes the cover save, the Conceal-targeting immunity, `inCoverForTargeting`, and every team rule that reads `.inCover`, in one place.

3. THREAD THE COVER SOURCE TO THE PROTECTIVE HOOK.
   a. src/core/sequences/shoot.ts, `TargetCheck` (line 78): add `coverFeatureIds: string[];`. Set it at the result literal around lines 203-214 to `[...new Set(cover.coverParts.map((p) => p.featureId))]`, and to `[]` in the `base` early-return literal at line 145.
   b. src/core/sequences/types.ts, `ShootSequence` (line 19): add `coverFeatureIds: string[];` beside `inCover` (line 39). Populate at src/core/sequences/shoot.ts:413 (`coverFeatureIds: check.coverFeatureIds`) and at the Torrent secondary re-check, src/core/sequences/shoot.ts:982-986 (`seq.coverFeatureIds = check.coverFeatureIds;`). In src/core/decisions.ts:44, the `coverOrObscured` branch, add `seq.coverFeatureIds = [];` alongside `seq.inCover = false;`.
   c. src/core/hooks.ts, `AttackContext` (line 116): add `coverFeatureIds?: readonly string[];` - OPTIONAL, so the ~40 hand-built AttackContexts in src/teams/**, the `inCover: false` literals in src/core/sequences/fight.ts (lines 343, 514, 536) and the weapon-selection context at src/core/sequences/shoot.ts:305-319 need no edit. Populate it in the shoot sequence's attack-context builder at src/core/sequences/shoot.ts:781-795: `coverFeatureIds: seq.coverFeatureIds,`.

4. REWRITE THE PROTECTIVE HOOK. src/core/equipment/portableBarricade.ts:143-163. Replace the whole handler body:

    register(reg, player) {
      reg.on('onDefenceDice', { id: `${PORTABLE_ID}.protective`, sourceText: equipmentText(PORTABLE_ID), player, priority: 30 }, (ev, b) => {
        const target = ev.ctx?.defender;
        if (!target || !ev.ctx.inCover) return;
        // "While an operative is in cover FROM THIS TERRAIN FEATURE": the sequence records which
        // features gave the cover, and `coverAndObscured` has already applied the Portable
        // connection gate, so there is no geometry left to redo here. The `f.owner === b.player`
        // clause is what keeps the bonus from being applied twice when BOTH players take a
        // portable barricade - the module registers once per player (cf. D-096 / W-24).
        const ids = ev.ctx.coverFeatureIds ?? [];
        const shield = ev.state.placedFeatures.find(
          (f) => f.kind === PORTABLE_KIND && f.owner === b.player && ids.includes(f.id),
        );
        if (!shield) return;
        // "improve its Save stat by 1 (to a maximum of 2+)" - the save is clamped at 2 already.
        ev.mods.save += 1;
      });
    },

   `polyCentroid`, `sub` and `dot` become unused imports in that file (line 18) - drop them. `shieldPoly` stays (used by `connectedBarricade`, `barricadeSpotIsLegal` and `perform`).
   IF the owner rules that only friendly operatives benefit (see ownerDecisionNeeded), add `&& target.player === b.player` to the guard AND, in change 2, an ownership filter - which `coverAndObscured` cannot express (it knows nothing about players), so it would have to become a second filter inside `checkTarget` on `cover.coverParts`. Do not build that unless the owner asks: the RAW-neutral version needs no such plumbing.

### Verifier objection — takes precedence over the plan above

CONFIRMED LIVE, and I strengthened one of the investigator's claims by proving it through the real reducer rather than a hand-built AttackContext. Reproductions: /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vfy-w23.test.ts and vfy-w23b.test.ts.

VERIFIED INDEPENDENTLY (barricade at (10,11) rot 0, body poly x 9.606..10.394 y 10.803..11.197, 32mm Move-6 test.trooper, shooter at (10,18)):
  y=10.55 connected=true  inCover=true  parts=[...0.body]
  y=10.2  connected=true  inCover=true
  y=9.9   connected=FALSE inCover=TRUE   <- unearned
  y=9.6   connected=FALSE inCover=TRUE   <- unearned
  y=9.2   connected=FALSE inCover=TRUE   <- unearned
  y=9.0   connected=false inCover=false
Unearned band 0.75\", as reported. Conceal at y=9.2: checkTarget => valid:false, reason 'target has a Conceal order and is in cover'; validTargets(shooter,'lasgun') => ['p1-1','p1-2'] — the target is dropped entirely. The feet never appear in coverParts (interveningParts skips Exposed at visibility.ts:258), so "(ignore its feet)" is already satisfied.
Enemy defender: p2 operative connected to p1's barricade => inCover true, coverParts [equip.p1.eq.portableBarricade.0.body], Protective mods.save 1. Confirmed — the hook at portableBarricade.ts:143-163 never checks target.player.
Both players take it: mods.save 1, not 2 — the double-application trap does not fire today only because the geometry happens not to match twice. Their test 5 is worth writing.

STRENGTHENED — ADDITION 2 PROVED END TO END, NOT JUST BY HAND-EMIT. vfy-w23b.test.ts drives a real `PerformAction Shoot` through `reduce` with a spy handler registered at priority 999 (after the equipment hook's 30) on the real onDefenceDice event: target at (9.4,9.6) NOT connected (`connectedBarricade` undefined), the only cover part is `blk.body` (a Heavy block), the shield at (8.2,10.3) contributes nothing — and the observed `ev.mods.save` in the live sequence is 1. So the +1 Save is handed out for cover the shield did not provide, in a real battle, not only in a synthetic event.

PLUMBING CLAIMS ALL CHECK OUT: TargetCheck is declared at shoot.ts:78 with the `base` early-return literal at 143-150 and the real result literal at 202-215; ShootSequence is populated at shoot.ts:413 and re-checked for Torrent at 980-986; decisions.ts:41 is the `coverOrObscured` branch; AttackContext (hooks.ts:116-132) has no cover source and no ctx; context.ts:126 is `ctx.equipment.get(eqId)?.register?.(reg, player)` with no GameContext where line 125 passes ctx to teams; HookRegistry.emit (hooks.ts:370-385) does no player filtering. The cycle is real: src/core/movement.ts:32 imports ./visibility.ts and portableBarricade.ts imports validateMove from ../movement.ts. `baseDistanceToPart` (terrain.ts:439-446) is literally `baseGapToPoly(centre, base, rotDeg, part.poly)`, i.e. the same measure `connectedBarricade` uses against `shieldPoly`, so the proposed gate and the action's connection test cannot disagree — good. src/teams/wyrmblade/index.ts:402 and src/teams/hernkyn-yaegir/index.ts:305 do read `part.solid !== false`. tests/teams/wrecka-krew.test.ts:1010 pushes a `parts: []` barricade but never registers eq.portableBarricade, so it does not move — and the rewrite actually removes the `shieldPoly(feature)` crash that would otherwise lurk there.

FOUR OBJECTIONS, none fatal:

(1) MISSED OWNER AMBIGUITY, and it is the load-bearing one. universal-equipment.txt:142 reads "This terrain feature only provides cover while AN OPERATIVE is connected to it AND if the shield is intervening". The investigator assumes without argument that "an operative" = the target. The competing reading is that the shield is only propped up while SOMEONE is holding it, so it provides cover to anyone behind it while any operative is connected. The plan silently implements the first reading in `coverAndObscured`, which has no notion of "any other operative" either. The target reading is the better one (the second clause is plainly per-attack, and "A suppression shield … that provides mobile cover" is about hunkering behind it), but it must be written into the D-entry alongside the friendly/enemy question, not assumed.

(2) BLAST SECONDARIES ARE NOT ADDRESSED. shoot.ts:987-989: for Blast, `seq.inCover` is deliberately NOT recomputed ("Secondary targets are in cover and obscured if the primary target was"), so `seq.coverFeatureIds` would carry the PRIMARY's cover features onto a secondary that is nowhere near the shield — and that secondary would collect the Protective +1. Decide it explicitly: either clear `coverFeatureIds` on the Blast branch (the shield gave the SECONDARY nothing) or state that Blast's inheritance carries the source too. The Torrent branch is fine because it re-checks.

(3) D-096 IS MIS-CITED. Change 4's comment justifies the `f.owner === b.player` clause with "cf. D-096". docs/DECISIONS.md:103 D-096 is about smoke softening Piercing living in the shoot sequence; it says nothing about per-player registration. The per-player fact is real (context.ts:124-128 loops players and registers each player's equipment) — cite the code, or write a new D-entry, not D-096.

(4) "THE CONNECTED_INCHES MOVE IS MANDATORY" IS OVERSTATED. It is a good move — terrain.ts is the right home and it is a leaf — but the alternative of simply declaring the constant in visibility.ts also closes the cycle. Not a reason to reject; just do not present it as forced.

MINOR, worth a line in the D-entry: the shield footprint is 20mm x 10mm (data/equipment/universal.json:7, "owner-measured 20mm wide … DEPTH ASSUMED 10mm (flagged)"), i.e. a 0.787\" x 0.394\" polygon. A 0.25\" connection radius against a 0.79\"-wide shield is a very small cover window; once cover depends on it, that provenance flag is load-bearing.

### Corrected plan

Take the plan essentially as written — changes 1 to 4 are correct in shape and the inline `continue` in `coverAndObscured`'s coverParts loop (not a CoverOpts predicate) is the right call, since 34 call sites exist and most pass no opts. Four amendments:

(a) Add to change 3a/3b: on the Blast branch at src/core/sequences/shoot.ts:987-989, set `seq.coverFeatureIds = []` (or resolve the question deliberately). Otherwise a Blast secondary inherits the primary's shield and collects the Protective +1 for cover it never had.

(b) Write the D-entry with THREE questions, not two: (i) is "an operative is connected to it" the TARGET or ANY operative — recommend the target, and note the plan cannot express "any operative" inside `coverAndObscured` at all; (ii) friendly-only or RAW-neutral — recommend RAW-neutral, as the investigator does, since universal-equipment.txt:140 and :142 both say "an operative" and only MOVE WITH BARRICADE is scoped ("Operatives connected to the INSIDE of it"); (iii) `CONNECTED_INCHES = 0.25` as the model of "connected to", measured base-edge to shield polygon, noting the deleted 1.5\" centre-to-centroid spelling was inconsistent and base-size dependent. Nothing in D-001..D-102 covers razor wire, Obstructing, Portable, Protective or the portable barricade — grep confirmed — so this is a genuinely new entry.

(c) Replace the "cf. D-096" comment in change 4 with a reference to src/core/context.ts:124-128 (rebuildHooks registers each player's equipment separately) or to the new D-entry.

(d) Test plan: keep tests 1-7 as written, and add the end-to-end shape I proved — a real `PerformAction Shoot` through `reduce` where the only cover part is a Heavy block and the defender is unconnected, asserting the observed `mods.save` is 0. That is the assertion that fails at HEAD in the live sequence (measured 1), and it is stronger than test 4(ii)'s hand-built AttackContext because it cannot be dismissed as state the reducer would never produce. Repro at /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vfy-w23b.test.ts.

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

### OWNER

Yes - one substantive, one to record. Nothing in docs/DECISIONS.md D-001..D-102 mentions the portable barricade, Protective or Portable; the closest precedent is D-096 ('the module registers once per player', which is why change 4 keeps the `f.owner === b.player` clause).

DECISION A (blocks test 6, and blocks the shape of changes 2 and 4). DOES AN OPERATIVE GET COVER, AND THE PROTECTIVE +1 SAVE, FROM AN ENEMY'S PORTABLE BARRICADE IT IS CONNECTED TO? The text is neutral: :142 says 'while AN OPERATIVE is connected to it' and :140 says 'While AN OPERATIVE is in cover from this terrain feature' - neither says 'friendly', and only the unique action is scoped ('Operatives connected to the INSIDE of it'). A portable barricade is terrain in the killzone once set up, and all other equipment terrain (light barricades, the heavy barricade) gives cover to whoever stands behind it regardless of who paid for it. RECOMMENDED: RAW - anyone connected to the shield with it intervening gets the cover and the +1 Save. That is also what the plan above implements with no extra plumbing. The audit's test plan asserts the opposite ('an ENEMY operative connected to it gets nothing') without a rule citation; if the owner prefers that, changes 2 and 4 both need an ownership filter, and change 2's would have to move out of `coverAndObscured` (which has no notion of players) into `checkTarget`.

DECISION B (record only). `CONNECTED_INCHES = 0.25` is an undocumented judgement - 'connected to' is modelled as the base being within a quarter inch of the shield polygon. It has been harmless while it only gated one action; once cover depends on it, it decides whether a shot lands. Promote it to a D-entry, and note in the same entry that the old 1.5in-centre-to-centroid test in the Protective hook was a second, inconsistent and base-size-dependent spelling of the same idea, now deleted.

### Files

`src/core/visibility.ts`, `src/core/terrain.ts`, `src/core/equipment/portableBarricade.ts`, `src/core/hooks.ts`, `src/core/sequences/shoot.ts`, `src/core/sequences/types.ts`, `src/core/decisions.ts`, `tests/equipment.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`


---

## W-28

*Effort: medium · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

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

### Where the original entry is wrong

Both headline claims in the title are now FALSE at HEAD; the body's third claim is TRUE; and three defects the audit never mentions are live.

(1) "Breach performs no control-range check" — FALSE. `src/core/actions.ts:588-592` has the check and it fires: a breacher 5.9" from the access point is rejected with 'the breach point is not within control range'; the same operative at 1.09" succeeds and the part flips to ['Accessible','Insignificant','Exposed'].
(2) "its concussion roll hits operatives on the breacher's own side of the wall" — FALSE. `acrossFrom()` (actions.ts:637-643) is applied at actions.ts:611-613: with a friendly 0.20" from the access point on the breacher's side and an enemy 0.00" from it on the far side, exactly ONE roll is made, against the enemy; the friendly stays at 10 wounds and [] aplMods.
(3) "the 2AP clause exists only as a comment" — TRUE, and now the ONLY surviving line of the entry. The clause appears exactly once inside the Breach action and it is a `//` comment (actions.ts:594-595); `actionsThisActivation` is never read there.

Line numbers have drifted: the audit cites actions.ts:493-520 (Breach), :461 (Operate Hatch), :499-500 (the comment). At HEAD they are 570-631, 529, and 594-595.

D-085 in docs/DECISIONS.md already records (1) and (2) as fixed — "Breach now opens the access point itself…, checks the breach point is within the operative's control range, and concusses only operatives on the far side of it". The audit entry was written before that landed.

Three live defects the audit does not name:
(a) control range to an access point is measured to the part's BOUNDING-BOX CENTRE through a phantom 20mm base, not to the part. On the 1.99"-long tomb-world-2 openings this loses 26.1% of the true control-range area (10469 sampled positions genuinely within 1" of the polygon, 7735 accepted). It is the same expression in four places and it also governs Operate Hatch, whose enemy-denial loop inherits it.
(b) killzones.txt:519's "1 less AP" discount is entirely unimplemented — `actionCost` returns 2 for every operative, and the words 'breach marker'/'grenadier' appear nowhere in actions.ts.
(c) the 2AP clause is not theoretical: PHOBOS STRIKE TEAM Vanguard (`src/teams/phobos-strike-team/index.ts:666-672`, "perform the Pick Up Marker or a mission action for 1 less AP") already takes Breach to 1AP, and Shoot-then-1AP-Breach in one activation is accepted today.

### Evidence (run, not read)

Scratch config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/cqkz2/vitest.config.ts, run from /home/user/kill-team-mobile at HEAD a775289 with a clean tree.

FILE /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/cqkz2/verify.test.ts — 17 tests, all passing. Real map data/maps/tomb-world/tomb-world-2.json, real breach point `tomb-world-2.B2-2.access` (bbox x 11.724-12.089, y 12.830-14.817, types ['Heavy','Wall'], opensAs 'breachWall'), driven through `reduce` with ActivateOperative + PerformAction.

  breacher at x=6: ok=false reason=the breach point is not within control range
  breacher at x=11: ok=true reason=-
  concussion rolls: ["concussion vs A"]        <- one roll, against the enemy on the far side only
  tomb-world-2.B2-2.access (breachWall) opening 1.99" long: true control-range cells 10469, accepted 7735 (73.9%)
  tomb-world-2.A4-1.access (hatch)      opening 1.99" long: true control-range cells 10469, accepted 7735 (73.9%)
  hugger true gap to AP polygon = 0.533
  victim true gap to AP pol …[truncated]

### Plan

THREE separable changes, all in src/core/actions.ts unless stated.

--- 1. Measure control range TO THE ACCESS POINT, not to its bbox centre (fixes Breach and Operate Hatch together) ---
`src/core/geometry.ts:303` already exports `baseGapToPoly(centre, base, rotDeg, poly, samples = 32)`. `src/core/actions.ts:10` currently imports only `{ baseGap, dist }` from './geometry.ts' — add `baseGapToPoly`.
Replace the expression `baseGap(X.pos, Xc.base, X.rot, centre, { shape: 'round', mm: 20 }, 0) > 1 + 1e-6` with `baseGapToPoly(X.pos, Xc.base, X.rot, part.poly) > 1 + 1e-6` at all four sites:
  (i)  actions.ts:545-546  Operate Hatch, the acting operative;
  (ii) actions.ts:548-551  Operate Hatch, the `enemyNear` loop (use `<= 1 + 1e-6` for the deny);
  (iii)actions.ts:589-592  Breach, the acting operative;
  (iv) actions.ts:617-618  Breach, the concussion victim filter in `perform` (`if (baseGapToPoly(other.pos, oc.base, other.rot, part.poly) > 1 + 1e-6) continue;`).
After (iii)/(iv) the local `bCentre`/`centre` constants are still needed by `acrossFrom(part, centre)` at actions.ts:611 — keep them, they are only removed from the distance test.
Keep the measurement 2D (`baseGapToPoly`, not a 3D variant): D-090 draws the line at operative-to-operative, and Gallowdark/Tomb World are flat boards.
Hatchway Fight (actions.ts:501-503) uses the same 20mm-proxy trick for its 2" test; that one is pinned by D-089 and by tests, so leave it out of this change and file it separately rather than silently widening it.

--- 2. Implement killzones.txt:519, the "1 less AP" discount ---
Add an optional member to `ActionDef` (declared in src/core/actions.ts near the registry):
  `apFor?(ctx: GameContext, state: GameState, op: OperativeState): number;`
and consult it in `actionCost` (actions.ts:646-649) BEFORE the hook emit, so team hooks still stack on top:
  `const printed = action.apFor ? action.apFor(ctx, state, op) : action.ap;`
  `const ev = ctx.hooks.emit('onActionCost', state, { state, operative: op, action: action.id, ap: printed });`
  `return Math.max(0, ev.ap);`
Give Breach `apFor: (ctx, _state, op) => (breachDiscount(ctx, op) ? 1 : 2)` and add a file-local helper:
  function breachDiscount(ctx, op): boolean {
    const dc = card(ctx, op);
    const words = /\b(breach marker|grenadier|mine)\b/i;   // "has the word(s) … on its datacard"
    const text = [dc.name, ...dc.keywords, ...dc.weapons.map(w => w.name),
                  ...dc.abilities.flatMap(a => [a.name, a.text]),
                  ...dc.uniqueActions.flatMap(a => [a.name, a.text])].join('\n');
    if (words.test(text)) return true;
    return dc.weapons.some(w => w.profiles.some(p =>
      !p.rules.some(r => r.id === 'Blast' || r.id === 'Torrent') &&
      p.rules.some(r => (r.id === 'Piercing' || r.id === 'PiercingCrits') && (r.x ?? 0) >= 2)));
  }
`'Piercing'` and `'PiercingCrits'` are the exact WeaponRuleId spellings (src/core/types.ts:199-200). The exclusion in :519 is per WEAPON ("excluding weapons that have the Blast or Torrent weapon rule"), so the Blast/Torrent test must be inside the same profile predicate, as above.
Keep `def.ap` at 2. The reducer's counteraction gate (`counteracting && def.ap !== 1`, reducer.ts:375) reads the PRINTED cost, so a discounted Breach still cannot be a counteraction — which is correct and also makes the "/counteraction" half of :523 unreachable, so only the activation half needs code.

--- 3. Implement killzones.txt:523's second sentence, both directions ---
The reducer computes the cost at reducer.ts:374 and only calls `def.check` at reducer.ts:389, so the cost is available but not passed. Add one line after reducer.ts:374:
  `next.opState['actionAp'] = { operativeId: op.id, action: def.id, ap };`
(and `delete next.opState['actionAp'];` after the perform block at reducer.ts:407, next to the existing `op.actionsThisActivation.push(...)`). This avoids re-deriving the cost inside check/perform, which would be wrong the moment a hook consumes its discount at cost time.
Forward direction — in `Breach.check`, after the existing 'already open' test and before the control-range test:
  const ap = Number((state.opState['actionAp'] as { ap?: number } | undefined)?.ap ?? 2);
  if (ap < 2 && (did(op, 'Charge') || did(op, 'Shoot')))
    return { ok: false, reason: 'Breach cannot be performed for less than 2AP in an activation in which it performed the Charge or Shoot action' };
`did` already exists at actions.ts:78 and `restrictionKey = def.treatedAs ?? def.id` (reducer.ts:369), so Charge records 'Charge' and Shoot records 'Shoot' verbatim.
Reverse direction ("or vice versa") — in `Breach.perform`, when that same `ap < 2`, push an effect:
  state.effects.push({ id: `breach${state.seq++}`, rule: 'breachDiscounted', source: { kind: 'core', id: 'Breach' }, operativeId: op.id, expiry: { kind: 'endOfActivation', operativeId: op.id } });
`ActiveEffect`/`EffectExpiry` are src/core/types.ts:274-293; `expireActivationEffects` (src/core/phases.ts:257) already drops `endOfActivation` effects on EndActivation (reducer.ts:424), so nothing else is needed to clean it up.
Then add to `Charge.check` (actions.ts:285, after the existing Reposition/Dash/Fall Back restriction) and to `Shoot.check` (actions.ts:388):
  if (state.effects.some(e => e.rule === 'breachDiscounted' && e.operativeId === op.id))
    return { ok: false, reason: 'already performed Breach for less than 2AP this activation' };

--- 4. Docs ---
docs/RULES-COVERAGE.md:35 currently claims "Breach 2AP + AP discounts + concussion roll (Tomb World) | ✔". The "AP discounts" half is false today; it becomes true with change 2. Add a DECISIONS entry for the datacard word-search surface used by `breachDiscount` (which fields count as "on its datacard").

### Verifier objection — takes precedence over the plan above

The item IS still live and the report's re-framing of the audit text (claims 1 and 2 FALSE, claim 3 TRUE, D-085 already covers 1 and 2) is correct — I confirmed the control-range check at /home/user/kill-team-mobile/src/core/actions.ts:588-592 and the acrossFrom() far-side filter at :611-618 by code read, and the report's own reproductions hold. But the PLAN is wrong in six places, five of which I proved by running code (all runs from /home/user/kill-team-mobile at HEAD a775289, config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/adv/vitest.config.ts).

(A) RULE MISREAD — change 3, forward direction. killzones.txt:523 says "It cannot perform this action FOR LESS THAN 2AP during an activation/counteraction in which it performed the Charge or Shoot action", and killzones.txt:519's discount is optional ("CAN perform this action for 1 less AP"). So after a Shoot the correct outcome is that the discount is unavailable and Breach costs 2AP — not that Breach is rejected. The plan rejects it outright with reason 'Breach cannot be performed for less than 2AP…'. This is not academic: /tmp/…/adv/w28c.test.ts shows phobos-strike-team.infiltrator-warrior has APL 3, so Shoot (1AP) + Breach (2AP) = 3AP is affordable and legal, and the plan would refuse a legal action. The plan also needlessly plumbs the cost into check() to do it.

(B) The apFor-before-hook ordering breaks killzones.txt:519's own floor "(to a minimum of 1AP)". PHOBOS Vanguard (src/teams/phobos-strike-team/index.ts:666-672) does `ev.ap = Math.max(0, ev.ap - 1)` with no floor. Run: `ctx.hooks.emit('onActionCost', s, {…, action:'Breach', ap:1})` returns **ap = 0**. Under the plan a Phobos grenadier-word operative Breaches for 0AP.

(C) The breachDiscount regex misses the ONE operative in the game that actually has 'breach marker' on its datacard. `\bbreach marker\b` matches **0 of 559 datacards**; kommandos.breacha-boy's unique action text reads "Place one of your Breach markers…" — plural, so the anchored boundary fails. Run output: `kommandos.breacha-boy matched by the proposed regex? false`, `of which matched on "breach marker": 0`.

(D) Arithmetic wrong: the word search hits **17 distinct datacards across 16 teams**, not "18 across 15". 11 match grenadier + 7 match mine = 18 with one card double-counted.

(E) The Blast/Torrent exclusion is implemented per PROFILE while killzones.txt:519 and the report's own prose say per WEAPON ("excluding WEAPONS that have the Blast or Torrent weapon rule"). Run: exactly one datacard diverges — canoptek-circle.geomancer (perProfile=true, perWeapon=false).

(F) The opState cleanup claim is factually false. The plan says "the revert at reducer.ts:390-405 restores `before`, which never had the key, so that path is already safe". `const before = clone(next)` is /home/user/kill-team-mobile/src/core/reducer.ts:388, i.e. AFTER the proposed insert at :375 — so `before` DOES carry `actionAp`, and the check-passed/perform-failed revert leaves it stale. Exactly the case the plan declares safe.

(G) The defect is characterised one-sidedly, and the risk section is wrong in the direction that breaks tests. The 20mm-proxy measurement produces FALSE POSITIVES as well as false negatives, which the report never mentions. Proved on data/maps/tomb-world/tomb-world-2.json against tomb-world-2.B2-2.access (bbox x 11.724-12.089, y 12.830-14.817): an operative at (13.800, 13.8235) has proxyGap 0.870 but trueGap **1.081** to the polygon, and its `PerformAction Breach` is **ACCEPTED today**. So change 1 also NARROWS the legal set; the report's "Change 1 WIDENS who may Breach/Operate Hatch … the AI will simply gain candidates" misses that any fixture standing perpendicular to a hatch at 1.0-1.4" flips from accepted to rejected.

(H) The site list is incomplete. The report says "the same expression in four places". The same bbox-centre + 20mm-proxy expression implementing killzones.txt:500's enemy-denial clause also lives in src/teams/battleclade/index.ts:1503 and :1509 (REMOTE ACCESS, treatedAs 'Operate Hatch') and src/teams/canoptek-circle/index.ts:1854 and :1865 (Obelisk Node Control, treatedAs 'Operate Hatch'). Fix only actions.ts and the identical printed clause is measured two different ways depending on which Operate Hatch variant is used. There are also two further copies inside actions.ts itself (:499 and :525, Hatchway Fight / touchingOpenAccessPoint) which the report does correctly defer to D-089.

### Corrected plan

Keep changes 1 and 2 in shape, with these edits.

1. Measurement: switch all sites to `baseGapToPoly(pos, base, rot, part.poly)` as proposed (src/core/geometry.ts:303 — it exists), but add src/teams/battleclade/index.ts:1503,1509 and src/teams/canoptek-circle/index.ts:1854,1865 to the list, or extract one exported core selector — e.g. `accessPointGap(index, ctx, op, part): number` in src/core/terrain.ts — and have all six sites call it. State the risk honestly in both directions and grep the maps/ops/teams suites for fixtures placed PERPENDICULAR to an access point at 1.0-1.4", not only for ones just outside.

2. :519 discount: keep `apFor`, but consult the hook FIRST and apply the printed floor after, or give apFor its own clamp so the :519 minimum survives: `const printed = action.apFor ? action.apFor(ctx, state, op) : action.ap; const ev = ctx.hooks.emit('onActionCost', …, { ap: printed }); return Math.max(0, ev.ap);` still yields 0 for Phobos. Either clamp Breach specifically (`Math.max(1, …)` when the discount fired) or record in DECISIONS that team discounts stack below the printed floor. Widen the word search to unanchored substrings for the plural forms — `/breach marker|grenadier|mine/i` matches kommandos.breacha-boy — and put the exact surface AND the anchoring choice in the owner question, with the corrected count (17 cards / 16 teams for the word half, 35 more datacards for the Piercing half). Move the Blast/Torrent exclusion up to the weapon level to match the printed text (one card changes: canoptek-circle.geomancer).

3. :523 forward: DO NOT reject. Make the discount conditional inside the cost, i.e. in `breachDiscount()` add `if (did(op, 'Charge') || did(op, 'Shoot')) return false;` (`did` is src/core/actions.ts:78; `restrictionKey = def.treatedAs ?? def.id` at reducer.ts:369 so 'Charge'/'Shoot' are recorded verbatim). Breach then simply costs 2AP after a Shoot, which is what :523 says, and the AP gate at reducer.ts:382 handles affordability by itself. Drop the `state.opState['actionAp']` plumbing entirely — with the cost decision moved into `actionCost`, `check` never needs the number, and the stale-key bug at reducer.ts:375/:388 disappears.

4. :523 reverse ("or vice versa"): keep the `breachDiscounted` endOfActivation effect blocking Charge and Shoot — that half is right, and phases.ts:257 / reducer.ts:424 do expire it as claimed. Note that the counteraction half is already unreachable because reducer.ts:375 gates on `def.ap !== 1`, which the report gets right.

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

### OWNER

One decision, plus one thing to record.

DECISION: which fields of a datacard count as "the datacard" for killzones.txt:519's word search. I propose name + keywords + weapon names + ability names and text + unique-action names and text. Including or excluding weapon PROFILE names, fluff, or the team name changes which operatives get Breach at 1AP. The owner should confirm the surface (and may want to see the 18-card list) before it becomes the number the AI budgets against.

RECORD, not decide: D-085 in docs/DECISIONS.md already documents the control-range check and the far-side concussion filter as owner-blessed. This change does not reverse D-085 — it corrects the MEASUREMENT inside it (polygon rather than bbox centre) and adds the two clauses D-085 never mentioned. Amend D-085 or add a successor row rather than opening the question again.

NOT an owner question: whether Guard/Close Quarters gating applies. Breach is a Tomb World rule (killzones.txt:455 heading, :502 section), not a Close Quarters one, and it is gated on the data (`opensAs === 'breachWall'`), so D-002 is not in play.

### Files

`src/core/actions.ts`, `src/core/reducer.ts`, `src/core/geometry.ts (import only — baseGapToPoly already exists at line 303)`, `tests/rules-review.test.ts`, `docs/RULES-COVERAGE.md`, `docs/DECISIONS.md`


---

## W-29

*Effort: large · verifier agrees it is live: True · verifier accepts the plan: True*

### Rule

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

### Where the original entry is wrong

Substantially accurate; four drifts. (1) `grep -rl volkus src/` now returns FOUR files, not two: src/core/visibility.ts, src/core/types.ts, src/ui/App.tsx, src/ui/MapBrowser.tsx. Still no killzone module. (2) "ten team modules already do seq.turn='defender'" undercounts: 18 sites across 17 team modules (src/teams/{wyrmblade:635, exaction-squad:409, fellgor-ravager:679, farstalker-kinband:1308, elucidian-starstrider:754, nemesis-claw:712, ratlings:660, blades-of-khaine:1204, celestian-insidiants:469, mandrakes:1286, corsair-voidscarred:575+592, raveners:1114+1137, sanctifiers:725, pathfinders:587, legionary:627, deathwatch:454}). The hook they use is `onCollectAttackDice`, which fires inside `rollSide`; `seq.turn` is read only at the `resolve` step, so flipping it there works. (3) The suggested test COORDINATES ARE WRONG: it says "a defender at (6.4,5.0) wholly inside Stronghold B with the attacker at (7.1,5.0) outside". On volkus-1 Stronghold B occupies x 3..11, y 3..11, so (7.1,5.0) is INSIDE it too — both operatives would be within the stronghold and the rule would (correctly) not fire. (4) The audit says W-29 is "gated on W-04". W-04 is marked FIXED and DID land the parapet banding + key F ramparts, but it did NOT land key C fire steps — data/terrain/volkus.json's strongholdA notes still read "Rules parts the map cards do not draw... the fire steps (Vantage + Insignificant + Exposed)", and `grep -ro fireStep data/` finds nothing. So the "…or a fire step" half of Condensed Stronghold is still unimplementable; only "on the killzone floor" can be enforced. Everything else in the entry checks out: startFight hard-codes turn:'attacker' (fight.ts:77), all six Volkus maps ship closeQuarters:false, and `grep -rni 'garrison|condensed stronghold|cityfight'` over src/ and tests/ returns nothing.

### Evidence (run, not read)

Scratch file /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/volkuskz/final.test.ts (helper in ./helper.ts), run with `npx vitest run --config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vitest.scratch.config.ts .../volkuskz/final.test.ts` from /home/user/kill-team-mobile — 6 tests, all pass, i.e. every assertion of the CURRENT wrong behaviour holds.

GARRISONED STRONGHOLD, on the real volkus-1 map: attacker p1-0 at (8.39,18.835) outside Stronghold A touching its door, defender p2-0 at (9.9,18.835) wholly inside on the killzone floor. Console from .../volkuskz/w29.test.ts:
  attacker wholly within Stronghold A? false
  defender wholly within Stronghold A? true
  control range: true
  fight started: true  step = defenderRerolls  turn = attacker
The assertion `expect((out.state.sequence as any).turn).toBe('attacker')` PASSES — killzones.txt:383 demands 'defender'.

CONDENSED STRONGHOLD, same map: shooter test.blaster (frag launcher, `Blast 2"`) at (20,17); target A at (15.5,17) z=0 wholly inside Str …[truncated]

### Plan

THREE PIECES. Register the killzone rules ONCE, not per player — this is the W-24 trap: `rebuildHooks` (src/core/context.ts:121-136) loops `for (const player of ['p1','p2'])`, so a module registered inside it would push Lethal twice and flip seq.turn twice.

1. src/core/terrain.ts — a cached feature footprint + a selector.
   * Add `footprints: Map<string, Poly>` to `TerrainIndex` (interface at terrain.ts:37). Fill it in `buildTerrainIndex` (terrain.ts:119-154) in the same pass that builds `parts`: for each feature, the convex hull (monotone chain) of every one of its parts' polygon vertices. Build it once — `effectiveRules` runs on every read of every weapon at every step of the shoot sequence and inside the AI's inner loop, so computing hulls per call is not acceptable.
   * `export function featureFootprint(index: TerrainIndex, featureId: string): Poly | undefined` — reads the map.
   * `export function whollyWithinFeature(index: TerrainIndex, centre: Vec2, base: BaseShape, rotDeg: number, kinds: readonly string[]): TerrainFeature | null` — for each feature whose `kind` is in `kinds`, return it when `baseWhollyWithin(centre, base, rotDeg, [footprint])` (geometry.ts:285, already samples centre + 32 perimeter points) is true; else null.

2. src/core/killzones/ — the registry (NEW directory; CLAUDE.md's Layout section needs a line for it, and context.ts:119 already documents the seam as "then killzone rules").
   * src/core/killzones/index.ts: `export interface KillzoneModule { id: KillzoneId; register(reg: HookRegistry, ctx: GameContext): void }` and `export const KILLZONE_MODULES = new Map<KillzoneId, KillzoneModule>([['volkus', volkusKillzone]])`.
   * src/core/context.ts `rebuildHooks`: immediately after `const reg = new HookRegistry();` and BEFORE the per-player loop, add `KILLZONE_MODULES.get(state.map.killzone)?.register(reg, ctx);`.
   * src/core/killzones/volkus.ts: `const STRONGHOLDS = ['volkus.strongholdA','volkus.strongholdB'] as const;`
     - GARRISONED STRONGHOLD. `reg.on('onCollectAttackDice', { id:'volkus.garrisonedStronghold', sourceText:'When an operative wholly within a stronghold terrain feature is retaliating against an operative that isn\'t, the defender resolves first (this takes precedence over the normal fight resolution order).', priority: 0 }, (ev) => { if (ev.ctx.type !== 'melee') return; const seq = ev.state.sequence; if (seq?.kind !== 'fight') return; const index = terrain(ctx, ev.state); const def = ev.state.operatives[seq.defenderId]!; const atk = ev.state.operatives[seq.attackerId]!; const inSh = (o) => whollyWithinFeature(index, o.pos, card(ctx,o).base, o.rot, STRONGHOLDS) !== null; if (inSh(def) && !inSh(atk)) seq.turn = 'defender'; })`. `seq.turn` starts 'attacker' (fight.ts:77) and is read only at the `resolve` case (fight.ts:207-209), so flipping it during `rollSide` is the same seam the 18 team modules use. Setting it twice (the hook fires once per side) is idempotent. Nothing else in fight.ts needs to change.
     - CONDENSED STRONGHOLD. `reg.on('onWeaponRules', { id:'volkus.condensedStronghold', sourceText:'<killzones.txt:378 verbatim>', priority: 0 }, (ev) => { if (ev.type !== 'ranged') return; const t = ev.target; if (!t) return; if (t.z > 1e-6) return; /* "on the killzone floor"; "or a fire step" is unimplementable, key C is not extracted */ if (!ev.rules.some(r => r.id==='Blast' || r.id==='Torrent' || (r.id==='Devastating' && r.dist !== undefined))) return; if (ev.rules.some(r => r.id==='Lethal' && (r.x ?? 6) <= 5)) return; /* never downgrade */ const index = terrain(ctx, ev.state); if (!whollyWithinFeature(index, t.pos, card(ctx,t).base, t.rot, STRONGHOLDS)) return; ev.rules.push({ id:'Lethal', x:5, raw:'Lethal 5+ (Condensed Stronghold)' }); })`. Keying off `ev.target` gets killzones.txt:380 for free: `advanceShoot` re-derives `rules` per target on every pass (src/core/sequences/shoot.ts:497), so a secondary target outside the stronghold is unaffected. Factor the trigger + no-downgrade test into an exported helper in src/core/weaponRules.ts (e.g. `blastTorrentDevastating(rules)` and `withLethal5(rules, label)`) and call it from BOTH `condensedEnvironmentRules` (weaponRules.ts:164-172) and here, so the two Cityfight/Close-Quarters spellings cannot drift.

3. Docs. docs/RULES-COVERAGE.md: add a "Cityfight: Condensed Stronghold, Garrisoned Stronghold, Door Fight" row to the killzone table (§ Killzone rules, currently ends at the Close Quarters row) marked ✔ for volkus / — elsewhere. docs/DECISIONS.md: one new decision for the footprint approximation and one for the Vantage-level reading (see ownerDecisionNeeded). CLAUDE.md Layout: add `killzones/` to the `src/core/` line.

### Verifier objection — takes precedence over the plan above

LIVE — confirmed independently. `grep -rniE "cityfight|garrison|condensed stronghold|door fight" src/ tests/ docs/RULES-COVERAGE.md` returns ZERO hits; `startFight` hard-codes `turn: 'attacker'` (src/core/sequences/fight.ts:77); all six volkus maps ship `closeQuarters: false`; DECISIONS.md D-001..D-102 has nothing on any of it. Their correction of the audit's undercount (18 `seq.turn = 'defender'` sites in 17 team modules) is exactly right, as is their catch that the audit's suggested attacker coord (7.1,5.0) is INSIDE Stronghold B (measured hull 3.00..11.00 x 3.00..11.00).

I PROVED THE PROPOSED SEAMS WORK rather than taking their word: /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vfy/c.test.ts registers an `onCollectAttackDice` handler on the real volkus-1 map that flips `seq.turn`; the hook fires twice (once per rollSide), and the fight ends with `turn = 'defender'` and the first `strikeOrBlock` decision going to p2. vfy/b.test.ts proves the `onWeaponRules` seam per-target: `inside: Blast2,Lethal5 / outside: Blast2 / inside-but-z=3: Blast2` — killzones.txt:380 does come for free, because `advanceShoot` re-derives `rules` with the CURRENT target on every loop iteration and feeds it straight to `addRolled(..., lethalOpts(rules))` (shoot.ts:497/536). Every API the plan leans on exists as claimed: `baseWhollyWithin` (geometry.ts:285), `partsSupporting` (terrain.ts:189), `IndexedPart.feature`/`featureId`, `available(ctx,state,op)` (actions.ts:40), and `rebuildHooks` really does loop per player (context.ts:122) with a doc comment already reading "then killzone rules" — the W-24 double-registration trap is real and their guard is correct.

FOUR OBJECTIONS.

(1) TWO PROPOSED TEST COORDINATES ARE STATES THE REDUCER CANNOT PRODUCE. Test 4's straddling defender at (9.2,18.835): `baseBlockedByTerrain` returns `volkus-1.A.p6` (wall/Heavy) and `validateMove` refuses with "cannot move through wall (Heavy)" (vfy/d.test.ts). It is not a near miss — Stronghold A's doorway is 1.167" clear (p10 y 18.250..19.417) and a 32mm base is 1.2598" across, so NO standard base can straddle or occupy that doorway; the test could only exist via a raw `put()`. Test 5's Condensed target at (15.5,17.0) is blocked by `volkus-1.M.p0` (beamRubble, Light, z 0..1, x 15.06..16.69 y 17.23..19.71), so a Reposition there fails too. Both need new coordinates — (11.8,17.0) measures terrain-legal, z=0, and wholly within Stronghold A's hull.

(2) THE RISK SECTION NAMES THE WRONG FIXTURES AND OVER-ANTICIPATES A RE-SEED. It lists four volkus-1 users plus soak.test.ts. `grep -rn "volkus-1" tests/teams/*.test.ts` shows SEVENTEEN team test files, thirteen of them running full seeded mirror battles through `for (const mapId of ['volkus-1','gallowdark-1'])` with behavioural log assertions (battleclade "TRANSFERS POWER"/"NETWORK COUNTERACTS", fellgor's Frenzy chain on a hand-picked seed 4245, etc.) — those go vacuous, not red, if a replay drifts. Against that, I instrumented nine complete seeded volkus-1 mirror soaks (vfy/soak.test.ts: battleclade, fellgor-ravager@4245, goremonger, hierotek-circle, ratlings, kommandos, wyrmblade, blooded, hunter-clade; all reached battleEnd with 0 rejected) with COUNT-ONLY probes that do not perturb the RNG. The Condensed trigger fired 0 times and the Garrisoned trigger 0 times in ALL NINE. So the D-102-style deliberate re-seed they tell the implementer to expect is, on this evidence, probably unnecessary — while the file list they hand over is a quarter of the real one.

(3) "THE CONVEX HULL … IS A CLEAN RECTANGLE ON ALL TWELVE INSTANCES" IS FALSE. My own measurement reproduces their areas exactly but not their shape claim: volkus-1.B has 5 hull vertices (63.74 vs bbox 64.00), volkus-4.A has 5, and volkus-6.A has SIX vertices with hull 49.27 sq in on an 8.42x6.00 bbox — 1.27 sq in larger than the nominal 8x6 and visibly not a rectangle. The hull is still tight and errs conservative, but on volkus-6 it counts a ~0.4" strip beyond the nominal footprint as "within", and the owner decision they ask for should be phrased against that, not against "exact".

(4) THE HULL SWALLOWS OTHER FEATURES INSIDE THE RING, WHICH THE PLAN NEVER MENTIONS. `volkus-1.K` (lightRubble) and `volkus-1.M` (beamRubble) both sit wholly inside Stronghold A's hull. That is arguably the right reading of "wholly within a stronghold", but it creates a case the ten proposed tests miss: an operative standing ON that rubble is at z=1, so it is inside the hull and NOT "on the killzone floor" — a second, more realistic version of their z=3 test 7, and the one a player will actually hit.

### Corrected plan

Keep the plan; fix the test plan and the risk note.

Test coordinates: replace test 4's straddling defender with a defender that overlaps the wall LINE at a legal spot, or delete it and instead assert the negative through the feature the engine can express — e.g. a defender wholly inside but on `volkus-1.M.p0` at z=1 (inside the hull, not on the killzone floor). Replace test 5's (15.5,17.0) with (11.8,17.0) z=0 (measured terrain-legal and wholly within Stronghold A). Add a test that an operative on the beamRubble at z=1 inside Stronghold A gets NO Lethal, quoting "and on the killzone floor or a fire step" (killzones.txt:378).

Risk: rewrite risk (c) as "seventeen team test files run seeded volkus-1 battles, thirteen through a `for (const mapId of ['volkus-1','gallowdark-1'])` mirror-soak loop whose assertions are behavioural log matches; a drifted replay makes them vacuous rather than red, so re-run the whole set. Measured across nine of those seeded battles the Condensed and Garrisoned triggers fired zero times, so a deliberate re-seed is probably NOT needed — confirm rather than assume."

Geometry decision: state it as "the convex hull of the feature's part polygons; measured 48.00/48.00/48.00/48.25/48.00/49.27 sq in for Stronghold A and 63.74/64.00x5 for Stronghold B against nominal 8x6 and 8x8, i.e. exact on ten of twelve instances and up to 1.27 sq in generous on volkus-6.A", and note that the hull encloses any other feature standing inside the ring.

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

### OWNER

FOUR, and none is already covered — docs/DECISIONS.md D-001..D-102 contains nothing on Cityfight, Garrisoned Stronghold, Condensed Stronghold or a killzone-module registry (D-002 is only about Close Quarters/`closeQuarters`, D-071 about the control-range door exemption, D-101 about the parapet). (1) ARCHITECTURE: introducing `src/core/killzones/` and a KillzoneModule registry is a new subsystem and a new line in CLAUDE.md's Layout; the audit flags this and it is worth agreeing before writing it. (2) GEOMETRY: what "wholly within a stronghold terrain feature" means on machine-extracted data. Proposal: the convex hull of the feature's part polygons, which measures as exactly the 8x6 / 8x8 wall ring on all twelve stronghold instances. Needs the same owner sign-off D-101's 1" parapet got. (3) READING: does an operative on a stronghold's Vantage LEVEL count as "wholly within" for Garrisoned Stronghold? Condensed Stronghold explicitly adds "and on the killzone floor or a fire step" and Garrisoned Stronghold does not, which reads as deliberate — so I would say yes, the roof counts, but it is an interpretation, not a quote. (4) SCOPE: "or a fire step" cannot be implemented. Key C fire steps are still not in the extracted geometry (data/terrain/volkus.json's own notes list them as not drawn, and W-04 landed only key F ramparts). Either the owner accepts a degraded "on the killzone floor" reading, recorded in DECISIONS + RULES-COVERAGE, or key C is extracted first.

### Files

`src/core/terrain.ts`, `src/core/killzones/index.ts`, `src/core/killzones/volkus.ts`, `src/core/context.ts`, `src/core/weaponRules.ts`, `tests/killzones/volkus.test.ts`, `docs/RULES-COVERAGE.md`, `docs/DECISIONS.md`, `CLAUDE.md`


---

## W-30

*Effort: medium · verifier agrees it is live: True · verifier accepts the plan: True*

### Rule

```
docs/rules-source/killzones.txt:385-395 —
385: "Action"
386: "Operatives can perform the following universal action."
388: "DOOR FIGHT1AP"
389: "Fight with the active operative (see fight sequence)."
391: "In the Select Enemy Operative step, instead select an enemy operative on the killzone floor and within 2\" of, and on the other side of, a door the active operative is touching. For the duration of that action, those operatives are treated as being within each other's control range."
393: "This action is treated as a Fight action. An operative cannot perform this action while within control range of an enemy operative, or if its base isn't touching a door."
395: "This action allows an operative to fight through a door — useful if the enemy is obstructing it and preventing your operatives from moving through."

Context that disproves the audit's stated cause — killzones.txt:266 "For the purposes of control range, ignore the door and parts of this terrain feature less than 2\" high when determining visibility." and killzones.txt:283 "The door is Accessible and Heavy terrain. For the purposes of control range, ignore the door when determining visibility."
```

### Where the original entry is wrong

The HEADLINE IS RIGHT — 'Door Fight' does not exist — but the STATED CAUSE AND BLAST RADIUS ARE WRONG, and the proposed `available` predicate would misfire across the whole suite.

(1) DISPROVED: "Fight requires real control range, which the Accessible+Heavy door denies across the doorway" and "A single defender permanently seals every building". Both are false at HEAD. killzones.txt:266 ("For the purposes of control range, ignore the door and parts of this terrain feature less than 2\" high when determining visibility") and killzones.txt:283 (the same for a large ruin's door) ARE implemented — src/core/visibility.ts:161-178 `controlRangeIgnores` returns true for `p.role === 'door'` on volkus.strongholdA/B and volkus.largeRuin, and `withinControlRange` passes `forControlRange: true`. Measured across Stronghold A's door: at base gaps 0.24"/0.39"/0.79" the operatives ARE in control range and `PerformAction Fight` is ACCEPTED. An enemy parked with its base centred in the doorway is in control range of an operative outside and can be fought normally, and the doors are `solid: false` + Accessible so operatives walk through them (a 2.15" traverse costs 4" — 2.15" rounded up plus the Accessible +1"). Nothing is sealed.
(2) The real live gap is narrower and I proved it: an enemy on the far side of a door at MORE than 1" (no control range) but within the printed 2" of the door cannot be fought at all, and the 1AP standing attack the rules provide for exactly that does not exist.
(3) Line drift: Hatchway Fight is at src/core/actions.ts:479, not :407. actions.ts registers exactly twelve actions (the audit is right); the full registry is 30 once ops and equipment register theirs.
(4) Already landed, so the audit's "reuse W-14's side-of-the-part test" is free: `acrossFrom(part, centre)` exists at src/core/actions.ts:637-643, and Hatchway Fight's `check` (actions.ts:494-505) now does both the 2" and the other-side tests.
(5) THE PROPOSED PREDICATE IS A BUG. The audit writes `available: (_ctx, state) => state.map.killzone === 'volkus'`. tests/fixtures.ts `testMap()` sets `killzone: 'volkus'`, so that predicate adds a Door Fight row to `availableActions`/`actionAvailability` in every synthetic fixture in the suite and hands the AI a candidate to probe on every board. It must also require the map to actually contain a `role: 'door'` part, the way `Operate Hatch` gates on an accessPoint existing (actions.ts:534-535).
(6) `state.map.closeQuarters` is false on all six Volkus maps and there are ZERO `role: 'accessPoint'` parts on them, so Hatchway Fight could not substitute even if the gate were removed.

### Evidence (run, not read)

All runs from /home/user/kill-team-mobile with the scratch config. Files: .../scratchpad/volkuskz/{w30.test.ts, w30b.test.ts, w30c.test.ts, w30d.test.ts, w30e.test.ts, final.test.ts}.

A. THE ACTION IS ABSENT. `allActions().map(a=>a.id)` on volkus-1 = Reposition, Dash, Fall Back, Charge, Pick Up Marker, Place Marker, Shoot, Fight, Guard, Hatchway Fight, Operate Hatch, Breach, Secure, Loot, Initiate Transmission, Move Orb, Download, Compile Data, Send Data, Reboot, Plant Device, Pick Up Intelligence, Retrieve, Scout, Plant Banner, Clear, Smoke Grenade, Stun Grenade, Ammo Resupply, Move With Barricade. `getAction('Door Fight') === undefined`. `reduce(..., action:'Door Fight')` → `reason: "unknown action 'Door Fight'"`.

B. THE DOORS ARE REAL AND UNIFORM. `terrain(ctx,state)` on volkus-1 yields 43 parts, 4 with `role:'door'`, 0 with `role:'accessPoint'`:
  volkus-1.A.p10 volkus.strongholdA  x 9.000..9.208  y 18.250..19.417  Accessible+Heavy  solid=false blocksVis=true
  volkus-1.B.p6  volkus.strongholdB  x 6.625..8.542  y  3.000.. 3.208
  volkus-1.C.p3  volkus.largeRuin    x 21.750..23. …[truncated]

### Plan

1. src/core/actions.ts — a new section "Volkus Cityfight actions" after the `Fight` registration (which ends at line 449) and before the Close Quarters block (line 451):

```ts
registerAction({
  id: 'Door Fight',
  name: 'Door Fight',
  ap: 1,
  type: 'universal',
  treatedAs: 'Fight',          // "This action is treated as a Fight action."
  sourceText: '<killzones.txt:388-393 verbatim>',
  // NOT `killzone === 'volkus'` alone: tests/fixtures.ts testMap() is killzone 'volkus'
  // with no terrain, and that predicate would offer Door Fight in every synthetic fixture.
  available: (ctx, state) =>
    state.map.killzone === 'volkus' && terrain(ctx, state).parts.some((p) => p.role === 'door'),
  check(ctx, state, op, params) {
    if (state.map.killzone !== 'volkus')
      return { ok: false, reason: 'Door Fight is a Killzone: Volkus (Cityfight) action' };
    if (engaged(ctx, state, op))                                   // :393
      return { ok: false, reason: 'within control range of an enemy operative' };
    const door = touchingDoor(ctx, state, op);                     // :393
    if (!door) return { ok: false, reason: 'its base isn’t touching a door' };
    if (!params.targetId) return { ok: false, reason: 'select an enemy operative through the door' };
    const target = state.operatives[params.targetId];
    if (!target || target.removed || target.player === op.player)
      return { ok: false, reason: 'select an enemy operative through the door' };
    if (target.z > 1e-6)                                           // "on the killzone floor"
      return { ok: false, reason: 'the enemy operative is not on the killzone floor' };
    const tc = card(ctx, target);
    if (baseDistanceToPart(target.pos, tc.base, target.rot, door) > 2 + 1e-6)   // "within 2\" of"
      return { ok: false, reason: 'the enemy operative is more than 2" from the door' };
    const centre = { x: (door.bounds.min.x + door.bounds.max.x) / 2,
                     y: (door.bounds.min.y + door.bounds.max.y) / 2 };
    const side = acrossFrom(door, centre);                          // "on the other side of"
    if (side(target.pos) === side(op.pos))
      return { ok: false, reason: 'the enemy operative is on the same side of the door' };
    if (weaponsOf(ctx, state, op, 'melee').length === 0)
      return { ok: false, reason: 'operative has no melee weapon' };
    return { ok: true };
  },
  perform(ctx, state, op, params) {
    const weapon = params.meleeWeaponName ?? weaponsOf(ctx, state, op, 'melee')[0]!.name;
    const r = startFight(ctx, state, op, weapon, params.meleeProfileName, params.targetId!, { hatchway: true });
    if (!r.ok) return r;
    advanceFight(ctx, state);
    return { ok: true };
  },
});

/** "a door the active operative is touching" — exact, not the bbox-centre proxy. */
function touchingDoor(ctx: GameContext, state: GameState, op: OperativeState) {
  const index = terrain(ctx, state);
  const c = card(ctx, op);
  return index.parts.find(
    (p) => p.role === 'door' &&
           op.z <= 1e-6 &&                                   // a doorway is a ground-level route
           baseDistanceToPart(op.pos, c.base, op.rot, p) <= 1e-6,
  );
}
```
Notes that are load-bearing:
 * Use `baseDistanceToPart` (src/core/terrain.ts:439, which is `baseGapToPoly` against the part's real polygon), NOT Hatchway Fight's `baseGap(..., bboxCentre, {round,20mm}, 0) <= 0.6` proxy (actions.ts:518-527). Stronghold B's door is 1.92" wide and large ruin D's is 1.88"; measuring to a 20mm disc at the bbox centre is badly wrong near a door's ends.
 * `acrossFrom` (actions.ts:637) already picks the split axis from the part's aspect: A's door is 0.208 x 1.167 so it splits by x, B's is 1.917 x 0.208 so it splits by y — both correct.
 * `{ hatchway: true }` is already the generic "ignore control range" flag on `startFight` (fight.ts:52,56); src/teams/exodite-dragon-masters/index.ts:1093 already reuses it for a non-hatchway rule. `seq.hatchway` is written (fight.ts:86) and never read again, so passing it has no other effect. Rename `opts.hatchway`/`FightSequence.hatchway` (src/core/sequences/types.ts:96) to `ignoreControlRange` in the same change and update the call sites — optional but it stops the field lying.
 * Do NOT change `assistCount`: killzones.txt:391 grants treated-as control range only to "those operatives", not to friendlies assisting, so assists must stay on real control range.
2. src/core/actions.ts `NEEDS_TARGET` (line 663-676): add `'Door Fight': 'operative'`.
3. src/ai/legal.ts: in the `switch (def.id)` at line 162, add `case 'Door Fight': out.push(...doorFightCandidates(ctx, state, op, def)); break;` — a copy of `hatchwayCandidates` (legal.ts:386-405) with the enemy filter widened to `e.z <= 1e-6 && gapBetween(ctx, op, e) <= 3 + 1e-6` (2" past the door plus the door's own thickness) and the label `door fight ${plan.targetId}`. Without the case it falls into `missionCandidates`, which probes `{targetId}` params and would work by accident but at three-attempt cost.
4. docs/RULES-COVERAGE.md: the Cityfight row (shared with W-29).

### Verifier objection — takes precedence over the plan above

LIVE — confirmed. `getAction('Door Fight') === undefined`; actions.ts registers exactly 12 actions (`grep -c "^registerAction({"`); zero hits for "Door Fight" anywhere in src/, tests/ or docs/RULES-COVERAGE.md; all six volkus maps carry exactly 4 `role:'door'` parts and ZERO `role:'accessPoint'` parts, with `closeQuarters:false`, so Hatchway Fight cannot substitute. Their line-drift correction is right (Hatchway Fight is at actions.ts:479, not the audit's :407) and every API the plan uses checks out: `acrossFrom` (actions.ts:637, and it picks the right split axis — door A is 0.208x1.167 so it splits by x, door B is 1.917x0.208 so it splits by y), `baseDistanceToPart` (terrain.ts:439), `treatedAs` honoured by the reducer as `restrictionKey = def.treatedAs ?? def.id` (reducer.ts:369), `startFight`'s `opts.hatchway` control-range bypass (fight.ts:56) with `seq.hatchway` written at :86 and never read again. Their disproof of the audit's stated cause is correct on the substance — I reproduced Fight being ACCEPTED across Stronghold A's door.

FOUR OBJECTIONS.

(1) ONE OF THEIR DISPROOF ILLUSTRATIONS USES AN UNREACHABLE STATE. Evidence C's "an enemy base centred in the doorway at (9.105,18.835) … control range TRUE, Fight OK. Not sealed." That position is terrain-ILLEGAL: `baseBlockedByTerrain` returns `volkus-1.A.p6` (wall/Heavy) — vfy/e.test.ts, which finds (9.105) blocked and (9.3, 9.5, 9.7, 9.85, 10.0, 10.4) legal. Stronghold A's doorway is 1.167" clear against a 1.2598" 32mm base, so nothing can stand in it. The conclusion survives on the legal positions they also ran (9.85/10.0/10.4 → Fight accepted), but the single most rhetorically load-bearing sub-case is state the reducer would never produce, and it should be struck rather than repeated to the owner.

(2) THE RISK RATING IS INVERTED RELATIVE TO THE OTHER TWO ITEMS. They rate W-30 "LOW … additive" and W-29 "MEDIUM" partly on seeded-replay grounds. Measured the other way round: across nine complete seeded volkus-1 mirror soaks (vfy/soak.test.ts) the Condensed trigger fired 0 times, the Garrisoned trigger 0 times and the capped z=6 plate was occupied 0 times — but operatives base-touching a door (gap <= 1e-6) were counted 28 times in the goremonger soak and 15 times in hierotek-circle. Door Fight is the only one of the three cluster items whose PRECONDITION the AI actually reaches on volkus-1 in seeded play, so it is the one most likely to perturb those thirteen mirror-soak replays once a new legal candidate enters `actionCandidates`. Their "no existing test asserts the size of the action registry" is true and beside the point.

(3) A COHERENCE PROBLEM ACROSS THE TWO PLANS IN THIS CLUSTER. W-29 proposes a new `src/core/killzones/` registry precisely because Volkus rules need a home, and then W-30 hard-codes `state.map.killzone === 'volkus'` twice inside `src/core/actions.ts`. That IS consistent with how Guard / Hatchway Fight / Breach are gated on `map.closeQuarters`, so it is not wrong — but the owner is being asked to approve a killzone-module seam in one item and a killzone string literal in core in the next, and the two should be reconciled in one answer.

(4) A CONCERN I RAISED AND THEN DISPROVED, recorded so nobody re-raises it: I expected `touchingDoor`'s `baseDistanceToPart(...) <= 1e-6` to be unreachable for the AI's 0.5" `reachableCells` grid (movement.ts:576-581). It is NOT a problem — the door part is `solid:false`, so a base simply overlaps it and `baseGapToPoly` clamps to zero. Measured: the closest cell on the AI grid gives gap exactly 0.000000, and their hand-picked (8.39,18.835) also gives exactly 0. The tolerance is fine as written.

### Corrected plan

Keep the plan. Three edits.

Strike the (9.105,18.835) "centred in the doorway" illustration from the write-up and replace it with the measured fact that matters: Stronghold A's doorway is 1.167" clear (volkus-1.A.p10 y 18.250..19.417) against a 1.2598" 32mm base, so an enemy cannot stand IN that doorway at all — it stands just inside it, at 0.2-0.8" gap where Fight already works, or 1-2" beyond it where nothing works. That is the honest shape of the gap and it is a stronger argument for Door Fight than "sealed", because it is what killzones.txt:395 describes.

Re-rate the risk: MEDIUM for seeded fixtures, not LOW, and name the measurement — door-touching stances occur 28x (goremonger) and 15x (hierotek-circle) per seeded volkus-1 mirror soak, so the thirteen `['volkus-1','gallowdark-1']` mirror-soak tests must all be re-run, not just the four named in W-29.

Add one owner question rather than deciding silently: does Door Fight live in `src/core/actions.ts` gated on `killzone === 'volkus'` + a door part (matching the existing Close Quarters precedent), or in the `src/core/killzones/volkus.ts` module W-29 introduces? Answer it once for the cluster.

### Test

tests/rules-review.test.ts (or tests/killzones/volkus.test.ts alongside W-29), on the REAL volkus-1 map, each test quoting killzones.txt:391 or :393. Stronghold A's door volkus-1.A.p10 spans x 9.000..9.208, y 18.250..19.417; outside is x<9, inside is x>9.208.
1. ACCEPTED: active p1 at (8.39,18.835) [baseDistanceToPart to the door === 0.000], enemy p2 at (11.0,18.835) z=0 [1.162" from the door, other side] → `PerformAction 'Door Fight' {targetId}` returns ok, `state.sequence.kind === 'fight'`, `sequence.attackerId`/`defenderId` are the two operatives, and `state.rejected.length === 0`.
2. REJECTED, same side: enemy at (7.0,18.835) → reason matches /same side of the door/.
3. REJECTED, not on the killzone floor: enemy at (10.0,18.835) z=3 standing on volkus-1.A.p11 → reason matches /killzone floor/.
4. REJECTED, too far: enemy at (12.0,18.835) z=0 → baseDistanceToPart to the door is 2.16" → reason matches /more than 2"/.
5. REJECTED, not touching a door: active at (7.0,18.835) (1.37" from the door) → reason matches /touching a door/.
6. REJECTED while engaged (killzones.txt:393): a second enemy placed within the active operative's control range → reason matches /within control range/.
7. treatedAs: after a `Fight`, `availableActions` reports Door Fight as `already performed Fight this activation` (this is what `treatedAs: 'Fight'` buys and it must be pinned).
8. GATING: `getAction('Door Fight')!.available(ctx, gallowdarkState, op) === false`, and === false on a `testMap()` state (killzone 'volkus', no door parts) — the regression guard for the audit's over-broad predicate.
9. THE MOTIVATING CASE, quoting killzones.txt:395: reproduce the run in the evidence — Reposition to the door, then Fight and Charge both refuse, and Door Fight succeeds. This is the test that would have failed before the change and is the honest statement of what the fix buys.
10. AI: `actionCandidates` for the operative in test 1 contains a `Door Fight` candidate, and a bot-vs-bot soak on a volkus map still reports zero rejected intents.

### Risk

LOW. Additive: one new action, one NEEDS_TARGET entry, one AI switch case. Three things to watch. (a) The `available` predicate — see the audit correction; gate on a door part existing, not on the killzone id alone, or every synthetic fixture grows a row. (b) `docs/ui-review/` action-sheet captures taken on a Volkus map will gain a Door Fight row; CLAUDE.md requires re-capturing them. (c) If the `hatchway` → `ignoreControlRange` rename is done in the same commit it touches src/core/sequences/types.ts:96, fight.ts:52/56/86, actions.ts:511 and src/teams/exodite-dragon-masters/index.ts:1093 — mechanical, but it is a five-file rename inside a rules change and could just as well be its own commit. No existing test asserts the size of the action registry (`grep -rn 'allActions()' tests/` → none), so nothing counts rows.

### OWNER

None required — docs/DECISIONS.md has nothing on Door Fight, and the rule is printed plainly. Two small judgement calls worth a line in the commit message rather than a decision: (1) killzones.txt:391 requires the TARGET to be "on the killzone floor" but says nothing about the active operative; I add `op.z <= 1e-6` to `touchingDoor` because the extractor gives a door the whole wall band (z 0..4 on a stronghold), so without it an operative standing on the level-1 Vantage floor at z=3 registers as "touching" the doorway below. (2) Hatchway Fight's own 2"/touching tests use a 20mm-disc-at-the-bbox-centre proxy with a 0.6" tolerance; Door Fight should use the exact `baseDistanceToPart`. Whether to retrofit that onto Hatchway Fight is a separate call — it would tighten a Close Quarters action and could move Gallowdark/Tomb World fixtures, so I would not bundle it here.

### Files

`src/core/actions.ts`, `src/ai/legal.ts`, `src/core/sequences/types.ts`, `src/core/sequences/fight.ts`, `tests/rules-review.test.ts`, `docs/RULES-COVERAGE.md`


---

## W-31

*Effort: small · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

```
docs/rules-source/killzones.txt:262-264 —
262: "H"
264: "You cannot have more than one friendly operative on the highest upper level of Stronghold B at once, and that operative must be placed on one side or the other of that level, it cannot be placed in the middle (this means an enemy operative cannot be prevented from moving onto or being set up on the other side). If an operative's base is too big to be placed there, it must move (or be set up) on as far as possible (otherwise it cannot complete that move), then place it to one side instead and treat it as being there. Hold it as far on that level as possible when it matters for checking other rules (e.g. control range, visibility, distance to other operatives, etc.). This takes precedence over the rules for bases and being in a location it can be placed."

Data provenance: data/terrain/volkus.json:181 — "At most one friendly operative may be on the highest upper level at a time, and it must be placed to one side, not in the middle (Killzones §Stronghold H) — carried as `maxOperatives: 1` on that part."; stamped by tools/maps/terrain.py:187.
```

### Where the original entry is wrong

Accurate on the substance; three corrections, one of them in the test plan.

(1) THE TEST PLAN NAMES THE WRONG PART. The audit says "with one friendly on volkus-1.B.p7". volkus-1.B.p7 is Stronghold B's LOWER Vantage level at z=3.0 (17-vertex floor, bbox 3.19,3.23..10.77,9.02) and carries no cap. The capped part — the "highest upper level" the rule is about — is volkus-1.B.p8 at z=6.0 (4-vertex plate, bbox 8.729,3.229..10.771,5.375, `maxOperatives: 1`). Every volkus map has exactly one such part: volkus-{1..6}.B.p8.
(2) Line drift: the stamp is at tools/maps/terrain.py:187, not :166.
(3) THE AUDIT'S FIX UNDER-STATES CLAUSE H. killzones.txt:264 carries five clauses and the audit's fix addresses one: the cap. It correctly defers the "one side, not the middle" half, but it never mentions the two clauses after it — the oversized-base fallback ("it must move (or be set up) on as far as possible (otherwise it cannot complete that move), then place it to one side instead and treat it as being there. Hold it as far on that level as possible when it matters for checking other rules") or the precedence clause ("This takes precedence over the rules for bases and being in a location it can be placed"), which explicitly overrides base-overlap and standability. On the extracted 2.04" x 2.15" plate NO base fits in a half of it (a 32mm base is 1.26" across against a ~1.02" half), so on this geometry the oversized-base fallback would be the NORMAL case, not the exception — a further reason the side-placement half cannot be guessed and must come from the extractor.
Everything else is right: `grep -rn maxOperatives src/` returns nothing, `maxOperatives` is not declared on `TerrainPart` (src/core/types.ts:85-113) yet survives JSON.parse and the `{...part}` spread in `buildTerrainIndex` (terrain.ts:130), validateMove's final-position block checks only solidity / hazardous / standability / board edge / base overlap / control range (movement.ts:280-310), and `canDeployAt` (reducer.ts:581-609) checks only drop zone / hazardous / base overlap. The audit's note that the cap is PER PLAYER is correct and is the thing most likely to be got wrong.

### Evidence (run, not read)

Run from /home/user/kill-team-mobile: `npx vitest run --config /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vitest.scratch.config.ts /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/volkuskz/w31c.test.ts` — 2 tests, both pass (both encode the current wrong behaviour). Also in .../volkuskz/final.test.ts and .../volkuskz/w31b.test.ts.

THE CAP IS IN THE INDEX AND NOTHING READS IT:
  p8 maxOperatives = 1  z = 6
  already on p8: [ 'p1-0' ]            (p1-0 placed at (8.8,3.9) z=6)
  Reposition -> true (accepted)         (p1-1 climbs from (10.1,5.3) z=3 to z=6 through the reducer)
  rejected intents: 0
  operatives on the highest level now: [ 'p1-0(p1) @8.8,3.9 z6', 'p1-1(p1) @10.1,5.3 z6' ]
Two FRIENDLY operatives, both supported by volkus-1.B.p8, and the reducer recorded no rejection.

THE 'ONE SIDE, NOT THE MIDDLE' CLAUSE IS ALSO UNENFORCED:
  finish dead centre of the top plate -> ACCEPTED    (validateMove to (9.4,4.6) endZ 6)

HOW MUCH ROOM THERE ACTUALLY IS (0.1" scan, `validateMove` with `moveOpti …[truncated]

### Plan

Implement the CAP only. Defer the side-placement and oversized-base halves explicitly (see ownerDecisionNeeded), and say so in docs.

1. src/core/types.ts — declare the field on `TerrainPart` (interface at line 85), next to `standable`/`solid`:
```ts
  /**
   * Cap on FRIENDLY operatives standing on this part at once. Killzones § Stronghold H:
   * "You cannot have more than one friendly operative on the highest upper level of
   * Stronghold B at once." Written by tools/maps/terrain.py; the engine must never hard-code
   * which level that is. Per player — an enemy may share the level.
   */
  maxOperatives?: number;
```
It already survives extraction (tools/maps/extract_cards.py:1182 passes it through) and `buildTerrainIndex`'s `{...part}` spread, so no data or extractor change is needed.

2. src/core/terrain.ts — add `capped: IndexedPart[]` to `TerrainIndex` (interface line 37) and fill it in `buildTerrainIndex`'s return (line 145) as `parts.filter((p) => p.maxOperatives !== undefined)`. This is the cheap early-out: `validateMove` is called thousands of times per AI decision (`reachableCells`, movement.ts:576, calls it per grid cell), so the cap loop must not run at all on the 18 non-Volkus maps or on any synthetic fixture.

3. src/core/movement.ts — in `validateMove`'s final-position block, insert after the board-edge test at line 288 and before the base-overlap loop at line 290:
```ts
  // Killzones § Stronghold H: "You cannot have more than one friendly operative on the
  // highest upper level of Stronghold B at once." The cap rides on the part
  // (`maxOperatives`), so the engine never has to know which level that is.
  if (index.capped.length > 0 && finalZ > 1e-6) {
    for (const part of partsSupporting(index, cur, finalZ)) {
      const cap = part.maxOperatives;
      if (cap === undefined) continue;
      const friends = aliveOperatives(state, op.player).filter(
        (o) => o.id !== op.id && partsSupporting(index, o.pos, o.z).some((q) => q.id === part.id),
      ).length;
      if (friends >= cap)
        return fail(
          `no more than ${cap} friendly operative can be on the highest upper level of that terrain feature at once`,
        );
    }
  }
```
`partsSupporting` (terrain.ts:189) tests the base CENTRE against the part polygon at |z1 − z| < 0.05, which is the same occupancy notion `canStandAt`/`surfaceAt` use — occupancy must be defined the same way for the mover and for the operatives already there, so use it on both sides. Filter by `op.player`: the cap is on FRIENDLY operatives, and killzones.txt:264's own parenthesis ("this means an enemy operative cannot be prevented from moving onto or being set up on the other side") is the rule saying so.

4. src/core/reducer.ts `canDeployAt` (line 581) — add an optional trailing `z?: number` parameter, `const atZ = z ?? surfaceAt(index, pos)`, and run the identical loop. Then pass `intent.z` from the `DeployOperative` case (reducer.ts:198). The three existing callers (reducer.ts:198, src/ui/command/setup.tsx:679, tests/core.test.ts:330-350) are source-compatible. Factor the loop into one exported helper so movement and deployment cannot drift — `export function occupancyCapExceeded(index, state, op, pos, z): IndexedPart | null` in src/core/terrain.ts, called from both.

5. docs/RULES-COVERAGE.md — the Known gaps bullet currently reads "Volkus Stronghold B 'only one friendly operative on the highest level, placed to one side' is data-only" (line ~118). Narrow it to the side-placement / oversized-base halves only, and add the cap to the killzone table.

### Verifier objection — takes precedence over the plan above

LIVE — confirmed, and their correction of the audit is right and important. `grep -rn maxOperatives src/` returns nothing; the cap is on `volkus-{1..6}.B.p8` only; on volkus-1 p8 is z=6.0, bbox 8.729..10.771 x 3.229..5.375 (2.042 x 2.146) and IS the highest standable part of feature B, while p7 (which the audit's test named) is the uncapped z=3.0 level. I reproduced the second-friendly Reposition to endZ 6 being accepted with `rejected.length === 0`, and my own `validateMove` sweep found 61 legal centres on the plate for a second friendly with the first already at (8.8,3.9), so two 32mm bases genuinely fit. Their insistence that the cap is PER PLAYER is correct and is backed by the rule's own parenthesis. The insertion point they name is real: `finalZ`, `cur`, the board-edge test and the base-overlap loop are all exactly where they say in `validateMove` (movement.ts:280-300). DECISIONS.md says nothing about `maxOperatives`.

I mark the plan UNSOUND on one substantive count and two smaller ones.

(1) THE PLAN DOES NOT COVER "OR BE SET UP" — killzones.txt:264 says "that operative must be placed (or be set up) …", and it is the plan's OWN stated motivation to "factor the loop into one exported helper so movement and deployment cannot drift". There are THREE copies of placement legality in this codebase, not two, and the plan patches two. The third is `src/teams/warpcoven/index.ts:1417` `canPlaceAt` — a private re-implementation of exactly the same checks (baseBlockedByTerrain / baseTouchesHazardous / board edge / basesOverlap), driven by `placementNear` at :1401 and written straight into `op.pos` at :1383, and it derives its elevation with `surfaceAt(index, pos)`, so it can land a Temporal Flux operative on the capped z=6 plate. `src/teams/tempestus-aquilons/index.ts:1807` DROP INSERTION is the same shape: `landingSpot` returns a `{pos, z}` and :1809-1811 assigns `op.pos` and `op.z = spot.z ?? 0` with no cap consultation. Ship the plan as written and the rule is enforceable by Reposition and by deployment but silently violable by two live set-up-again paths.

(2) THE `finalZ > 1e-6` EARLY-OUT BAKES IN AN ASSUMPTION THE DATA DOES NOT GUARANTEE. It is a hidden "caps only exist above the killzone floor" rule sitting in `validateMove` where nobody will look for it. It is correct today (the one capped part is z=6) but it silently disables the whole mechanism for any future floor-level cap — and there is already a candidate: docs/RULES-COVERAGE.md:106 lists the Tomb World teleport pad's "one operative" rule as unimplemented, and `onTeleportPadId` (types.ts:334) is only read for mutual control range (state.ts:189), never for occupancy. `index.capped.length > 0` alone is the correct and equally cheap guard.

(3) THE RISK SECTION IS WRONG IN BOTH DIRECTIONS, AND I MEASURED IT. It says "the AI will now see fewer reachable cells at z=6 on Volkus, which can perturb a seeded soak". Across nine complete seeded volkus-1 mirror battles (vfy/soak.test.ts — battleclade, fellgor-ravager@4245, goremonger, hierotek-circle, ratlings, kommandos, wyrmblade, blooded, hunter-clade; all reached battleEnd, 0 rejected) NO operative was EVER supported by the capped part (`onP8 = 0`, `capViolation = 0`). Since the guard only rejects when a friendly ALREADY occupies the part, no cell is removed in any of those games and the seeded-replay risk is nil on this evidence. Conversely the fixture list is understated the same way W-29's is: seventeen team test files touch volkus-1, thirteen through the `['volkus-1','gallowdark-1']` mirror-soak loop.

(4) Cosmetic: they report `canDeployAt.length === 4`. The signature is five parameters (`ctx, state, op, pos, rotDeg = 0`, reducer.ts:581-586); `.length` stops at the first default. Their substantive point — there is no `z` parameter — is right.

### Corrected plan

Adopt the plan's shape but widen it and change the guard.

Export ONE helper and call it from all THREE placement sites, not two: `export function occupancyCapExceeded(index: TerrainIndex, state: GameState, op: OperativeState, pos: Vec2, z: number): IndexedPart | null` in src/core/terrain.ts, called from (a) `validateMove`'s final-position block (movement.ts, after the board-edge test at :288), (b) `canDeployAt` (reducer.ts:581, with the new optional `z` fed from `intent.z` at :203), and (c) the set-up-again path — either by having `src/teams/warpcoven/index.ts:1417` `canPlaceAt` and `src/teams/tempestus-aquilons/index.ts` `landingSpot` call it, or, better, by exporting a single core `canSetUpAt(ctx, state, op, pos, z)` that those two private copies delegate to. Quote the rule's own "(or be set up)" in the helper's doc comment so the third site cannot be dropped again.

Change the early-out to `if (index.capped.length > 0)` with no `finalZ` condition, and compute occupancy with `partsSupporting(index, pos, z)` on both sides as the plan already says. The cost is still zero on the 18 non-Volkus maps and on every `testMap()` fixture, and it leaves the mechanism available to the Tomb World teleport pad's identical one-operative rule (RULES-COVERAGE.md:106) instead of quietly excluding it.

Rewrite the risk section around the measurement: "nine seeded volkus-1 mirror battles were instrumented and the capped part was never occupied, so no reachable cell is removed and no replay drifts; nevertheless all seventeen volkus-1 team test files (thirteen of them mirror soaks) must be re-run to confirm." Add one test the plan is missing: a set-up-again placement (warpcoven Temporal Flux or Tempestus DROP INSERTION) onto volkus-1.B.p8 with a friendly already there must be refused — that is the test that would fail against the plan as currently written.

### Test

tests/rules-review.test.ts, on the REAL volkus-1 map, every test quoting killzones.txt:264. Use volkus-1.B.p8 (z=6), NOT p7. The legal box on that plate is x 8.8..10.1, y 3.9..5.3 (measured), so (8.8,3.9) and (10.1,5.3) are two legal, non-overlapping stances 1.91" apart.
1. CAP FIRES: friendly p1-0 at (8.8,3.9) z=6; p1-1 at (10.1,5.3) z=3 performs `Reposition {path:{points:[{x:10.1,y:5.3}], endZ:6}}` → the intent is REJECTED, `state.rejected.length === 1`, the reason matches /more than 1 friendly operative/, and p1-1's z is still 3. (This test passes today with `ok === true` and must flip.)
2. THE CAP IS PER PLAYER: identical setup but the climber is p2-0 → ACCEPTED, and afterwards exactly two operatives are supported by volkus-1.B.p8, one per player. This is the assertion that catches the most likely implementation mistake.
3. FIRST ONE IS FINE: with the level empty, p1-1's same Reposition is ACCEPTED.
4. THE CAP IS NOT GLOBAL: two friendly operatives both finish on volkus-1.B.p7 (the uncapped z=3 level, e.g. (5.0,5.0) and (7.0,7.0)) → both ACCEPTED.
5. LEAVING AND RETURNING: the occupant Repositions off the plate, then the second friendly's climb is ACCEPTED — proves the count is computed from live positions, not a sticky flag.
6. DEPLOYMENT: `canDeployAt(ctx, state, op, {x:10.1,y:5.3}, 0, 6)` with a friendly already at (8.8,3.9) z=6 returns `{ok:false}` with the same reason; with an enemy there instead the refusal is the drop-zone one, not the cap (assert on the reason string, so the test cannot pass by silence).
7. NO-OP ELSEWHERE: on a `testMap()` state (`index.capped.length === 0`) a move to any z is unaffected — the early-out guard.
8. EVERY MAP: for all six volkus maps, exactly one part carries `maxOperatives` and it is the highest standable part on that map (a data assertion alongside tests/maps-volkus-vantage.test.ts).

### Risk

LOW. The change only ever FORBIDS a position, so any fixture that silently depended on two friendlies sharing Stronghold B's top plate would fail loudly rather than drift; I found none, and the four seeded team tests that use volkus-1 (tests/teams/{goremonger:967, hierotek-circle:166, raveners:360, wyrmblade:1164}.test.ts) plus tests/teams/soak.test.ts should be re-run to confirm. Two real hazards. (a) PERFORMANCE: without the `index.capped.length > 0` early-out this adds an O(operatives x standable parts) sweep to every `validateMove`, and `reachableCells` calls it per grid cell inside the AI's 300ms decision budget — the guard is not optional. (b) THE PER-PLAYER FILTER: dropping `op.player` turns the rule into "one operative of any side", which contradicts the rule's own parenthesis and would let a single enemy lock the level; test 2 exists for exactly that. Also note the AI will now see fewer reachable cells at z=6 on Volkus, which can perturb a seeded soak that used to send a second operative up there.

### OWNER

None for the cap — docs/DECISIONS.md D-001..D-102 says nothing about maxOperatives, docs/RULES-COVERAGE.md already lists it under Known gaps, and the rule text is unambiguous. TWO deferrals need recording as an owner decision rather than being guessed. (1) The "must be placed on one side or the other of that level, it cannot be placed in the middle" half needs the plate split into two side sub-polygons by tools/maps/terrain.py; the cards do not print where the division is, so it needs the same provenance + confidence treatment as D-101's parapet. (2) Related and worse: on the extracted 2.04" x 2.15" plate a 32mm base (1.26") does not fit inside either ~1.02"-wide half, so killzones.txt:264's oversized-base fallback ("it must move on as far as possible... then place it to one side instead and treat it as being there... This takes precedence over the rules for bases and being in a location it can be placed") would be the NORMAL case on this geometry, not the exception — and "treat it as being there" means the operative's effective position for control range, visibility and distance differs from where its base sits, which the engine has no representation for. Both should be filed with W-04's unfinished half (keys C/D/E are still not extracted) rather than approximated here.

### Files

`src/core/types.ts`, `src/core/terrain.ts`, `src/core/movement.ts`, `src/core/reducer.ts`, `tests/rules-review.test.ts`, `docs/RULES-COVERAGE.md`


---

## W-32

*Effort: large · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

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

### Where the original entry is wrong

The arithmetic is EXACTLY right and I re-counted it myself: every Bheta-Decima map has exactly ONE Heavy part, `bheta-decima-N.D.p0`, the condenser body. Zero parts have role 'pillar'. All eight gantry features per map are a single zero-thickness deck part at z0=z1=3.0 typed ['Accessible','Vantage','Light'].

The engine half is also exactly right: `checkTarget` (src/core/sequences/shoot.ts:130-231) applies Range, the friendly-control-range block, `isVisible`, cover/obscured, Vantage Accurate and the Conceal denial, and returns. Neither shoot.ts nor visibility.ts contains the string 'hazard', 'gantry' or 'footprint'.

The battlements claim is right: `data/terrain/bheta-decima.json` declares a fourth condenser part `{role:'rampart', types:['Light'], z0:3.0, z1:3.75, source:'green_edge'}` plus the height `bheta.condenser.battlement = 3.75"`, and it is emitted on 0 of 6 maps.

TWO things in the audit are now WRONG, and one is new:
(1) "docs/RULES-COVERAGE.md:102 marks both rows as covered, which is misleading" — no longer true. At HEAD line 108 reads "…`terrain.ts::baseTouchesHazardous`; the 4\"-of-hazardous targeting restriction is pending" and lines 115-117 list restricted targeting under "Known gaps". The doc has already been corrected; only the gantry-pillar side is still unmentioned.
(2) The audit blames the missing battlements on nothing in particular. The cause is precise and one branch wide: `bheta_features` in tools/maps/extract_cards.py:795-801 dispatches only `pspec['from_'] == 'green'` and `== 'green_inner'`. The condenser's rampart is `from_='green_edge'` (tools/maps/terrain.py:292), and the string 'green_edge' appears NOWHERE in extract_cards.py. Volkus's ramparts come from `_split_wall_band` (extract_cards.py:1453-1503, D-101), not from a green_edge producer — so green_edge is a source name that was never implemented.
(3) NEW: the condenser's inner `ledge` part is emitted on 5 of 6 maps — `bheta-decima-6` has 10 parts, not 11, because `_inner_blob` (extract_cards.py:810-822) finds no chipless orphan blob inside the condenser outline on that card.
(4) NEW: the catalogue types every gantry deck ['Accessible','Vantage','Light'], but killzones.txt:577 prints only "Gantry floors are Accessible and Vantage terrain" — the Light is added by the extractor and is not recorded in docs/DECISIONS.md. It is doing real work: on a floor-to-floor shot the two intervening parts today are `bheta-decima-1.C.p0` and `.B3.p0`, both Light gantry decks.

One architectural fact the audit assumes away: there is no killzone-module registry. `rebuildHooks` (src/core/context.ts:121-133) registers teams, equipment and ops only — its own doc comment at :119 promises "then killzone rules" and nothing does it. This is the same missing piece W-29/W-30/W-31 need.

### Evidence (run, not read)

Scratch configs /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/cqkz2/vitest.config.ts and /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vitest.cqkz.config.ts, run from /home/user/kill-team-mobile at HEAD a775289.

FILE /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/cqkz2/verify.test.ts (17 tests, all passing) — counted through `buildTerrainIndex`, not by eye:
  bheta-decima-1: parts=11 heavy=bheta-decima-1.D.p0 rampart=0 pillar=0 gantryGroups=bheta-decima-1.g2
  bheta-decima-2: parts=11 heavy=bheta-decima-2.D.p0 rampart=0 pillar=0 gantryGroups=none
  bheta-decima-3: parts=11 heavy=bheta-decima-3.D.p0 rampart=0 pillar=0 gantryGroups=none
  bheta-decima-4: parts=11 heavy=bheta-decima-4.D.p0 rampart=0 pillar=0 gantryGroups=bheta-decima-4.g1
  bheta-decima-5: parts=11 heavy=bheta-decima-5.D.p0 rampart=0 pillar=0 gantryGroups=none
  bheta-decima-6: parts=10 heavy=bheta-decima-6.D.p0 rampart=0 pillar=0 gantryGroups=bheta-decima-6.g3,bheta-decima-6.g9
  catalogue …[truncated]

### Plan

TWO halves. The ENGINE half is blocked on an architectural choice; the DATA half is blocked on an owner measurement. They can land independently.

=== ENGINE ===
Where it goes. `checkTarget` already emits `onValidTarget` (src/core/sequences/shoot.ts:159-167) with a mutable `{ valid, reason }`, which is the right seam — but nothing registers killzone hooks, because `rebuildHooks` (src/core/context.ts:121-133) only walks teams/equipment/ops even though its comment at :119 promises "then killzone rules". Two routes:
  (A) PREFERRED — add the registry the comment already promises. `src/core/killzones/index.ts` exporting `killzoneModules(): Map<string, KillzoneModule>` where `KillzoneModule = { id: string; register(reg: HookRegistry, ctx: GameContext): void }`; `src/core/killzones/bhetaDecima.ts` registers an `onValidTarget` handler; `rebuildHooks` gains three lines before the per-player loop:
        const kz = ctx.killzones?.get(state.map.killzone);
        kz?.register(reg, ctx);
     `ctx.killzones` is filled in `createGameContext` (src/core/game.ts:30-31) exactly like `ctx.ops` and `ctx.equipment`. This is the same registry W-29 (Volkus Garrisoned/Condensed Stronghold), W-30 (Door Fight) and W-31 (maxOperatives) want; build it once.
  (B) FALLBACK if the owner does not want the registry yet — an inline selector, exactly as Condensed Environment is done today (`if (state.map.closeQuarters) rules = condensedEnvironmentRules(rules);`, shoot.ts:269). Add `restrictedTargetingDenies(index, a, t): string | undefined` to src/core/visibility.ts and call it in `checkTarget` immediately after the `isVisible` block (shoot.ts:181-183) and before `vantageAccurate`:
        if (!opts.pointBlank) { const r = restrictedTargetingDenies(index, view, t); if (r) return { ...base, reason: r }; }
     Gate it on a new `KillzoneMap.restrictedTargeting?: boolean` written by the extractor, not on `map.killzone === 'bheta-decima'` — same principle as D-002's "gated by `map.closeQuarters`, never by killzone id".

The selector itself (identical body under either route), in src/core/visibility.ts:
  const onFloor = (b: Body) => b.z <= 1e-6;
  // :604 — "only matters if one or more … are on the killzone floor"
  if (!onFloor(a) && !onFloor(t)) return undefined;
  const lines = targetingLines(a, t, 10);          // :598 "use targeting lines"
  // :594 floor-to-floor, 4" of hazardous
  if (onFloor(a) && onFloor(t)) {
    const over = lines.filter(l => hazardChord(index.hazardous, l) >= 4 - 1e-6).length;
    if (over === lines.length) return 'more than 4" of hazardous area is between them';   // see the owner question
    return undefined;
  }
  // :596 Vantage <-> floor, a gantry footprint
  const decks = index.parts.filter(p => p.role === 'floor' && p.feature.kind.startsWith('bheta.gantry'));
  const groupOf = (p: IndexedPart) => p.feature.groupId ?? p.featureId;          // :579 connected gantries are one terrain
  const ignore = new Set([...decksTouching(decks, a), ...decksTouching(decks, t)].map(groupOf));  // :596 "on or in"
  const blockers = decks.filter(p => !ignore.has(groupOf(p)));
  if (blockers.some(p => lines.some(l => segmentCrossesPoly2D(l.from, l.to, p.poly)))) return 'a gantry footprint is between them';
  return undefined;
Notes that matter:
  * `hazardChord` must sum the segment's length inside every `index.hazardous` polygon; `index.hazardous` already exists (src/core/terrain.ts:48, :152). It is a 2D test — :606 defines a footprint as "the gantry itself, plus the area underneath it", so use the deck POLYGON in plan view and `segmentCrossesPoly` (src/core/geometry.ts:261), NOT the 3D part crossing that `interveningParts` does.
  * `decksTouching(decks, b)` = decks where `baseGapToPoly(b.pos, b.base, b.rot, deck.poly) <= 1e-6`. "on or in" covers both standing ON the deck (z=3) and standing UNDER it (z=0), and base overlap is the right test for a model that overhangs.
  * `p.feature.kind.startsWith('bheta.gantry')` follows the existing precedent in the same file (visibility.ts:176 tests `kind === 'volkus.strongholdA'`). If the owner prefers, mark the decks instead with a new part flag from the extractor.
  * The condenser roof is Accessible+Vantage but is NOT a gantry, so it must not appear in `decks`.
  * An operative on the condenser inner LEDGE settles to z=3.0 on the roof floor part, so `isOnVantage` already returns true for it — :583's "ignore the slight difference in height" needs no extra code.

=== DATA ===
1. Gantry pillars (killzones.txt:578). `'pillar'` is ALREADY in the `PartRole` union (src/core/types.ts:72), so no type change. In tools/maps/terrain.py, add to each of `bheta.gantryShort/Medium/Long` (lines 263, 272, 277) a second part `dict(role='pillar', from_='deck_ends', types=['Heavy'], z0=0.0, z1=h('bheta.gantry.deck'), blocksVisibility=True, solid=True, standable=False)` and add a `bheta.gantry.pillar` entry to HEIGHTS/notes carrying `provenance` + `confidence` like every other extracted value. In tools/maps/extract_cards.py `bheta_features` (:794-801), add the `deck_ends` producer: take the deck polygon's minimum-area rectangle, and emit one axis-aligned square of side `bheta.gantry.pillar.width` centred at each end of the long axis, inset by half its width so it lies inside the footprint. Then `pnpm maps:extract && pnpm maps:overlay` and update docs/MAPS.md's QA table.
2. Condenser battlements (killzones.txt:584). The single missing branch: in the same dispatch add `elif pspec['from_'] == 'green_edge':` producing the ring between the outer condenser polygon and its `green_inner` ledge blob (or, when there is no inner blob, an inward offset band of `bheta.condenser.battlement.width`). This is the whole reason the declared `rampart` part is emitted 0/6.
3. `bheta-decima-6` also loses the `ledge` part because `_inner_blob` (extract_cards.py:810-822) finds no orphan inside the condenser outline on that card. Look at docs/maps/overlays/bheta-decima-6.png before changing `_inner_blob`'s bounding-box containment test — it may simply be that map 6's condenser is drawn with the inner detail merged.
4. Record the gantry decks' extra 'Light' type (killzones.txt:577 prints only Accessible + Vantage) in docs/DECISIONS.md, or drop it once pillars carry the Heavy cover the rule intends. Today it is what supplies ALL cover on the board, so do not drop it in the same change as adding pillars without re-measuring.
5. docs/RULES-COVERAGE.md: line 108's "the 4\"-of-hazardous targeting restriction is pending" and the Known-gaps bullet at 115-117 come out; the killzone table's bheta-decima column for Heavy/Light gains the pillars.

### Verifier objection — takes precedence over the plan above

Still live, and the report's data audit is accurate — I re-counted through `buildTerrainIndex` independently and got the same numbers (bheta-decima-1..5: 11 parts, bheta-decima-6: 10; exactly one Heavy part per map, `bheta-decima-N.D.p0`; roles floor×9 / wall×1 / ledge×1, no pillar, no rampart). `green_edge` appears 0 times in /home/user/kill-team-mobile/tools/maps/extract_cards.py and the dispatch at :795-801 really does handle only 'green' and 'green_inner'. Neither src/core/sequences/shoot.ts nor src/core/visibility.ts contains 'hazard', 'gantry' or 'footprint'. `rebuildHooks` (src/core/context.ts:119-133) really does promise "then killzone rules" and register none. Quote line numbers :573-613 all verified. But the plan has one rule-level defect that would ship a wrong rule, one claim that rests on an engine bug the report mistook for a feature, and several scope errors.

(A) RULE MISS — Blast/Torrent secondaries. core-rules.txt:818: "Secondary targets are other operatives visible to and within x of the primary target … (**they are all valid targets**, regardless of a Conceal order)." `checkTarget` is invoked with `{ secondary: true }` at src/core/sequences/shoot.ts:478 and :981 and its `.valid` is what gates the secondary. Route B's guard is only `!opts.pointBlank`, so restricted targeting would deny Blast splash across the ocean or across a gantry footprint. Route A is strictly worse: the `onValidTarget` event object (shoot.ts:158-167) carries neither `secondary` nor `pointBlank`, so a killzone module registered there physically CANNOT make the distinction without extending the event. The plan presents A and B as interchangeable; they are not.

(B) The claim "[the gantry deck Light] is doing real work … it is what supplies ALL cover on the board, so do not drop it in the same change as adding pillars without re-measuring" rests on an engine bug, not on the data. `interveningParts` takes a pure-2D `segmentCrossesPoly` whenever `Math.abs(a.z - b.z) < 0.05` (src/core/visibility.ts:275-279), ignoring the part's elevation entirely. A gantry deck is z0 = z1 = 3.0 and operatives are 1.9" tall, yet I reproduced ground-level shots where the ONLY intervening part is `bheta-decima-1.C.p0 z3-3` and `checkTarget` returns `inCover: true` — e.g. (9.41,16.42) z0 → (5.81,16.42) z0, four such pairs found by sampling. So Bheta-Decima has no legitimate cover at all today; the apparent cover is a same-height 2D artefact. This is a live defect inside the cluster's blast radius that the report never names, and plan item 4 would be "re-measuring" phantom cover.

(C) The green_edge finding is under-scoped. `from_='green_edge'` is declared by TWO pieces: `bheta.condenser` (tools/maps/terrain.py:292) AND `volkus.largeRuin` (tools/maps/terrain.py:209). I checked the shipped data: volkus-1.C and volkus-1.D carry only wall/wall/wall/door/floor — the large ruins' declared rampart is emitted 0/6 on Volkus too. The report's "Volkus's ramparts come from `_split_wall_band`, so green_edge is a source name that was never implemented" is true of strongholds and silently wrong about large ruins, so the one missing branch costs two killzones.

(D) The group-vs-feature ignore scope is decided in the plan and pinned in test 5, but killzones.txt:610's own worked example says "the LEFT GANTRY is ignored when determining this, as operative A is on it" — singular feature — which cuts against :579's "treated as the same terrain". The report itself calls this "the assertion most likely to be got wrong". That makes it a fourth owner question, not a plan decision.

(E) `onFloor` gate. :596 and :604 both scope the gantry branch to "an operative on VANTAGE terrain". The plan's `if (!onFloor(a) && !onFloor(t)) return undefined;` then runs the gantry branch for any non-floor body without testing `isOnVantage`. Harmless on today's Bheta data (the only elevated standable surfaces are Vantage) but wrong as written.

(F) Symbol errors: the plan names `segmentCrossesPoly2D`; the export is `segmentCrossesPoly` (src/core/geometry.ts:261). `polyGap` is in src/core/equipment/kit.ts:91, not geometry.

(G) Unmeasured detail behind the percentages: `index.hazardous` is 1, 2, 2, 4, 5 and 1 polygons on maps 1-6 respectively. "4\" of hazardous area is between them" summed across several disjoint polygons versus one contiguous 4\" chord is a second, independent reading question the report never raises, and it is the one that moves the 38-61% number.

(H) Minor: bheta-decima-6's missing `ledge` is presented as a NEW defect, but that part is declared `optional: true` (tools/maps/terrain.py:291; the field is declared at src/core/types.ts:452). Nothing in tools/ actually reads `optional`, so it is an annotation only — worth saying, because it means the absence is indistinguishable from an intended one.

(I) Minor: the condenser roof part (`bheta-decima-1.D.p1`, role 'floor') is also typed ['Accessible','Vantage','Light'] while killzones.txt:582 prints only Accessible + Vantage. The plan's DECISIONS item covers only gantry decks.

### Corrected plan

Engine: take route A (the registry the comment at src/core/context.ts:119 already promises — W-29/W-30/W-31 all need it), but the `onValidTarget` event must gain `secondary?: boolean` and `pointBlank?: boolean`, passed through from `checkTarget`'s `opts`, before any killzone handler can implement this rule. Then the handler returns early on `ev.secondary` — core-rules.txt:818 "they are all valid targets". Add a test asserting a Blast 2\" primary across 13\" of ocean is denied while its secondary beside the primary is still resolved.

Before the Light-vs-pillars question can be answered at all, fix or explicitly scope the `sameHeight` branch at src/core/visibility.ts:275-279: a part whose [z0,z1] lies entirely above `max(a.z, b.z) + height` cannot be crossed by a base-to-base line and must not be intervening. Otherwise every cover measurement on Bheta is meaningless. File it as its own item rather than folding it in silently.

Add `volkus.largeRuin` to the green_edge scope: implementing the producer fixes killzones.txt:584 on Bheta AND the large-ruin ramparts on Volkus, so the extractor change and the QA-table update in docs/MAPS.md cover both killzones.

Add the group-vs-feature ignore scope (killzones.txt:579 vs the :610 example) and the cumulative-vs-contiguous reading of "4\" of hazardous area" as owner questions 4 and 5, alongside the ANY/EVERY question the report already raises. Gate the gantry branch on `isOnVantage(index, body)` (src/core/visibility.ts:437), not merely on "not on the floor".

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

### OWNER

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

*Effort: large · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

```
docs/rules-source/killzones.txt:525-528 (KILLZONE: TOMB WORLD section, heading at :455):
:525 "Teleport Pad"
:526 "A teleport pad is Exposed, Insignificant and Vantage terrain. Only one operative can be on it at once, and whilst an operative is on it, that operative cannot touch the killzone floor (in other words, an operative can't be both on the teleport pad and on the killzone floor). Equipment terrain features cannot be set up within 2\" of a teleport pad. Whenever an operative's base is touching a teleport pad, if another operative is on that teleport pad, those operatives are treated as being within each other's control range."
:528 "From the start of the second turning point, whenever a friendly operative on a teleport pad performs the Charge, Fall Back or Reposition action, you can teleport it. If you do, don't move it. Instead, remove it from the killzone and set it back up on the other teleport pad. It must still fulfil all other requirements of that action, otherwise it cannot teleport (e.g. if it's the Charge action, the operative must finish that action within control range of an enemy operative). If another operative is on the other teleport pad when an operative teleports, swap them around (if it's an enemy operative, its controlling player sets it up). An operative cannot teleport more than once per activation."

And the official FAQ, docs/rules-source/tomb-world.txt:112-113:
"Q: When an operative teleports, is it treated as having moved for the purposes of rules with a distance requirement (e.g. BROOD BROTHER Alpha Predator, PLAGUE MARINE Lumbering Death, VESPID STINGWING Neutron Charge)?  A: No."

Supporting: docs/rules-source/killzones.txt:456 "…2x each other terrain feature specified here. Note that some mission maps use less than this." (why a one-pad map is legal), and killzones.txt:205 "Vantage terrain is the upper levels of the killzone — areas operatives can be placed upon…" with :217 "…so long as part of its base is always on the Vantage terrain" (why partial overhang is normally fine, and therefore why clause 3 needs its own rule).
```

### Where the original entry is wrong

Accurate on every count, with only line drift and two additions.

- "OperativeState.onTeleportPadId is declared in types.ts:318" — it is types.ts:334 at HEAD.
- "read in exactly one place — src/core/state.ts:149" — it is state.ts:189 at HEAD. Otherwise exact: `if (a.onTeleportPadId && b.onTeleportPadId && a.onTeleportPadId === b.onTeleportPadId) return true;`
- "assigned NOWHERE in src/" — confirmed by scanning every .ts under src/core for an assignment (as opposed to the `===` comparison): zero hits. `grep -rn onTeleportPadId src/ tests/ data/` returns exactly two lines, the declaration and the read.
- "the wrong condition… the rule is one operative ON the pad and another merely TOUCHING it, whereas the code requires both to be on the same pad, which the one-operative limit forbids" — exactly right, and it is worse than the audit says: the branch ignores distance entirely. With the field forced on both operatives and their centres 15"+ apart, `inControlRange` returns TRUE.
- "no teleport action, no teleport variant… no teleport branch in movement.ts" — confirmed: `/teleport/i` does not match src/core/movement.ts, and the 12 actions offered to an operative standing on a pad in TP2 contain nothing teleport-shaped.
- "nothing enforces the one-operative limit, the 'not on the killzone floor' clause or the 2\" equipment exclusion" — all three reproduced as live.
- "docs/RULES-COVERAGE.md:101 currently claims the control-range half works" — still true at HEAD, now line 107: "Teleport pad (one operative, not on the floor, mutual control range, teleport from TP2) | ◐ … `state.ts::inControlRange` — the teleport move itself is pending". Three of the four things that row credits are unimplemented, not just the move.

TWO additions the audit does not mention:
(1) data/maps/tomb-world/tomb-world-1.json and tomb-world-3.json ship ONE teleport pad each; maps 2, 4, 5, 6 ship two. killzones.txt:528 says "set it back up on the OTHER teleport pad", so teleport is simply unavailable on maps 1 and 3 — and killzones.txt:456 ("Note that some mission maps use less than this") makes a one-pad map legitimate rather than an extraction bug. Any implementation must handle it rather than assume a partner pad exists.
(2) tomb-world.txt:112-113 carries an official FAQ the audit's plan does not account for: "Q: When an operative teleports, is it treated as having moved for the purposes of rules with a distance requirement…? A: No." So the teleport branch must not run the normal move machinery or emit move hooks.

The prompt's framing is right that killzones.txt:526 is one paragraph carrying several rules. It is FIVE clauses, not four; the enumeration is in the plan below.

### Evidence (run, not read)

Scratch configs /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/cqkz2/vitest.config.ts and /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/vitest.cqkz.config.ts, run from /home/user/kill-team-mobile at HEAD a775289, clean tree.

FILE /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/cqkz2/verify.test.ts — 17 tests, all passing, one per clause, on the real data/maps/tomb-world/tomb-world-2.json (the map with both pads):

  CLAUSE 1 (terrain types) — IMPLEMENTED in data:
    tomb-world-2.T-1.pad Exposed+Insignificant+Vantage z0-0.2 standable=true span=2.312x2.312"
    tomb-world-2.T-2.pad Exposed+Insignificant+Vantage z0-0.2 standable=true span=2.312x2.312"

  CLAUSE 2 (only one operative on it) — NOT ENFORCED. Through the reducer, not just validateMove:
    pad tomb-world-2.T-1.pad centre (10.06,15.73) span 2.312"; the two seats are 1.322" apart (32mm bases are 1.260" across, so they do not overlap)
    second operative Reposition onto the occupied pad: ok=true r …[truncated]

### Plan

THE FIVE CLAUSES IN killzones.txt:526, AND :528, WITH STATUS:
  C1  "A teleport pad is Exposed, Insignificant and Vantage terrain."                                        IMPLEMENTED (data; data/terrain/tomb-world.json `tomb-world.teleportPad`, role 'teleportPad', z0 0 -> z1 0.2 from `cq.teleportPad.top`, confidence photogrammetry).
  C2  "Only one operative can be on it at once"                                                             NOT IMPLEMENTED.
  C3  "whilst an operative is on it, that operative cannot touch the killzone floor"                        NOT IMPLEMENTED.
  C4  "Equipment terrain features cannot be set up within 2\" of a teleport pad."                            NOT IMPLEMENTED.
  C5  "Whenever an operative's base is touching a teleport pad, if another operative is on that teleport pad, those operatives are treated as being within each other's control range."   PRESENT BUT DEAD AND BACKWARDS.
  :528 the teleport move                                                                                    NOT IMPLEMENTED.

=== C5 — derive it, do not cache it (this is the correction to the audit's own plan) ===
The audit proposes stamping `op.onTeleportPadId` "after every position change (settleZ is the natural home)". That is the wrong fix: `settleZ` is called from only TWO places (reducer.ts:204 DeployOperative and reducer.ts:564 MoveOperativeFree) and NOT from the move path — `moveApply` sets `op.pos` and `op.z` directly at actions.ts:152-153. A cached field is what created this bug (architecture rule 7 forbids exactly this shape). Derive it instead:
  1. DELETE `onTeleportPadId?: string;` from src/core/types.ts:334.
  2. In src/core/terrain.ts, extend `TerrainIndex` with `teleportPads: IndexedPart[]` populated in `buildTerrainIndex` (parts with `role === 'teleportPad'`) so the hot path can bail in one array-length check, and export:
       export function padOccupiedBy(index, pos: Vec2, z: number): IndexedPart | undefined
         // "on it": z is the pad's top and the centre is inside it
         index.teleportPads.find(p => Math.abs(p.z1 - z) < 0.05 && pointInPoly(pos, p.poly))
       export function padsTouchedBy(index, pos, base, rot): IndexedPart[]
         index.teleportPads.filter(p => baseGapToPoly(pos, base, rot, p.poly) <= 1e-6)
  3. Replace src/core/state.ts:187-189 in `inControlRange` with:
       const index = terrain(ctx, state);
       if (index.teleportPads.length > 0) {
         const padA = padOccupiedBy(index, a.pos, a.z);
         if (padA && padsTouchedBy(index, b.pos, card(ctx, b).base, b.rot).some(p => p.id === padA.id)) return true;
         const padB = padOccupiedBy(index, b.pos, b.z);
         if (padB && padsTouchedBy(index, a.pos, card(ctx, a).base, a.rot).some(p => p.id === padB.id)) return true;
       }
     `terrain(ctx, state)` is already called on the very next line, and it is memoised on `ctx.terrainCache` (src/core/context.ts:109-115), so this adds no index rebuild.
  4. Because it is symmetric by construction, the CLAUDE.md "control range is mutual" invariant is satisfied without a second call site.

=== C2 — one operative per pad ===
In `validateMove`'s end-of-position checks (src/core/movement.ts, beside the existing base-overlap and Vantage-standability guards) and in `canDeployAt` (src/core/reducer.ts:578+, beside `baseTouchesHazardous`):
  const pad = padOccupiedBy(index, endPos, endZ);
  if (pad && aliveOperatives(state).some(o => o.id !== op.id && padOccupiedBy(index, o.pos, o.z)?.id === pad.id))
    return fail('only one operative can be on a teleport pad at once');
NOTE the difference from W-31's Volkus cap: this one is not per player. "Only one operative can be on it at once" excludes ENEMIES too. Reject into `state.rejected` with the rule text per architecture rule 1.

=== C3 — not also on the killzone floor ===
Only if the owner picks the strict reading (see ownerDecisionNeeded). If so, in the same end-of-position check:
  if (pad && !basePerimeter(endPos, base, rot, 24).every(p => pointInPoly(p, pad.poly)))
    return fail('an operative cannot be both on a teleport pad and on the killzone floor');
`basePerimeter` is src/core/geometry.ts:55; there is also `baseWhollyWithin` already used by `canDeployAt`.

=== C4 — equipment 2" ===
Add `'moreThan2FromTeleportPads'` to `PlacementConstraint` (src/core/equipment/kit.ts:34-44) and a case in `checkConstraint` (src/core/equipment/index.ts:205-256):
  case 'moreThan2FromTeleportPads':
    return index.teleportPads.some(p => polyGap(poly, p.poly) <= 2 + 1e-6)
      ? 'it must be more than 2" from a teleport pad' : undefined;
But do NOT add it to each module's `constraints` list — the rule is about EVERY equipment terrain feature, and hand-listing it in barricades.ts, portableBarricade.ts, markers.ts and every faction kit is how it gets missed. Apply it once, unconditionally, in `validateEquipmentPlacement` (src/core/equipment/index.ts:184-187), immediately after the per-item constraint loop:
  if (item.kind === 'terrain') { const fail = checkConstraint('moreThan2FromTeleportPads', {...}); if (fail) return { ok: false, reason: fail }; }
`item.kind` is already 'marker' | 'terrain' (kit.ts:54), and killzones.txt:526 says "Equipment TERRAIN FEATURES", so markers are correctly exempt. Killzones.txt:613's Bheta-Decima override does not apply on Tomb World.

=== :528 — the teleport move ===
  1. `MoveOptions` (src/core/movement.ts:60-77) gains `teleport?: boolean`.
  2. In `moveApply` (src/core/actions.ts:130-165), branch BEFORE `validateMove`: when `opts.teleport`, do not build legs at all — the FAQ (tomb-world.txt:112-113) says a teleport is not a move for distance-requirement rules, so no `onMoveDistance`/`onMoveRules` emit and no `MovePath` legs.
  3. Preconditions, each rejected with its own reason: `state.turningPoint >= 2`; `padOccupiedBy(index, op.pos, op.z)` is defined; the map has exactly one OTHER `role: 'teleportPad'` part (so tomb-world-1 and tomb-world-3, which ship ONE pad each, reject with 'this killzone has only one teleport pad'); the operative has not already teleported this activation.
  4. Destination: the other pad's centroid, at that pad's z1. Then apply the ACTION'S OWN end-of-move requirements to the new position — Charge's `mustFinishEngaged`, Reposition/Dash's `mustNotFinishEngaged`, base overlap, hazardous — reusing the same predicates `validateMove` uses for its final position rather than re-implementing them. "It must still fulfil all other requirements of that action, otherwise it cannot teleport."
  5. Swap: if the other pad is occupied, move that operative to the vacated pad. When it is an ENEMY, killzones.txt:528 says "its controlling player sets it up" — that is a `PendingDecision { who: <enemy player>, kind: 'teleportSwap', options }` per architecture rule 3, resolved before the activation continues. When it is a friendly, the active player places it (same decision, different `who`) or it takes the vacated centroid by default.
  6. Once per activation: an `ActiveEffect { rule: 'teleported', operativeId, expiry: { kind: 'endOfActivation', operativeId } }`, cleaned up by `expireActivationEffects` (src/core/phases.ts:257) exactly as W-28's discount marker is.
  7. `src/ai/legal.ts` must enumerate the teleport variant of Reposition/Charge/Fall Back so bots can use it, and `src/ui/command/` needs a branch (never a new screen — CLAUDE.md).

=== Docs ===
docs/RULES-COVERAGE.md:107 currently credits four things and delivers one; rewrite it clause by clause. Add a DECISIONS row for the C3 reading and for the derive-don't-cache correction.

### Verifier objection — takes precedence over the plan above

The strongest of the three reports, and its central corrections to the audit are right — I verified them independently. `grep -rn onTeleportPadId src/ tests/ data/` returns exactly two lines (src/core/types.ts:334, src/core/state.ts:189); the branch has no distance test; and the audit's proposed fix is genuinely disproved — `settleZ` appears in src/core only at src/core/reducer.ts:204, :564 and its definition at src/core/state.ts:374, while `applyMove` sets `op.pos`/`op.z` directly at src/core/actions.ts:152-153, so a cached field would be stale after every Reposition. I also reproduced C2 and C5 myself on data/maps/tomb-world/tomb-world-2.json through the reducer (/tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/adv/w33.test.ts): a second friendly Repositions onto occupied pad T-1 (ok=true, pos (9.511,15.23), z=0.2) with the first still at z=0.2; and for A on the pad at (9.545,15.73) z=0.2 and B touching its east edge at (11.837,16.596) z=0, `gapBetween` = 1.207 and `inControlRange` = **false** where the rule says true. Pad data confirmed (2 pads on maps 2/4/5/6, 1 on maps 1 and 3; 2.312\" square, Exposed+Insignificant+Vantage, z0 0 → z1 0.2, standable). Four objections.

(A) `padOccupiedBy` DUPLICATES an existing core selector. The plan specifies `index.teleportPads.find(p => Math.abs(p.z1 - z) < 0.05 && pointInPoly(pos, p.poly))`. That is character-for-character `partsSupporting` (src/core/terrain.ts:189-191), whose own doc comment at :188 literally reads "Is the part on the TELEPORT PAD / a Vantage floor the operative stands on?". Run: `partsSupporting(index, padCentre, 0.2)` returns `['tomb-world-2.T-1.pad']`. Adding a second selector for the identical query is precisely the duplication CLAUDE.md's selector rule exists to prevent, and it will drift from `canStandAt`/`isOnVantageAt` (src/core/movement.ts:486-494), which decide standing with the same centre-in-poly test.

(B) C4 leaves a hole the plan claims to close. It says "do NOT add it to each module's constraints list — the rule is about EVERY equipment terrain feature" and then applies it in `validateEquipmentPlacement` only. `src/core/equipment/portableBarricade.ts:72-75` carries its own independent placement predicate for Move With Barricade; a portable barricade can therefore be set up again within 2\" of a teleport pad without ever passing through the guarded path. killzones.txt:526 says "cannot be SET UP within 2\"", which is exactly what Move With Barricade does.

(C) The oval reasoning is not a proof, and the blast radius is misstated. "a 75x42mm oval is 2.953\" long; the pad is 2.312\" across — it cannot fit wholly within" ignores the square's 3.27\" diagonal. I tested every distinct base shape in data/teams/** at 15° increments with `baseWhollyWithin(padCentre, base, rot, [pad.poly])`: only the 75×42 oval fails, and it is **3 datacards on one team** (exodite-dragon-masters.dragon-master-clanblade / -leystalker / -stonesinger). The 60×35 oval fits (diagonally), 50mm rounds fit with 0.343\" of slack. So the owner question should say "3 cards on EXODITE DRAGON MASTERS lose teleport pads entirely", not "every large operative".

(D) Line drift the report introduces: `validateEquipmentPlacement` starts at src/core/equipment/index.ts:161, not 184 — 184-187 is the constraint loop it names as the insertion point, which is correct.

### Corrected plan

Drop `padOccupiedBy` and express C2/C3/C5 through the existing selector: `partsSupporting(index, pos, z).find(p => p.role === 'teleportPad')`. Keep `padsTouchedBy` (there is no existing equivalent) but put it in src/core/terrain.ts next to `partsSupporting` so the pair reads as one API, and keep `index.teleportPads` purely as the `length > 0` early-out for the hot `inControlRange` path.

For C4, either route Move With Barricade's placement through `validateEquipmentPlacement` so the unconditional check applies once, or add the same `moreThan2FromTeleportPads` test to src/core/equipment/portableBarricade.ts:72-75 alongside the two 2\" tests already there — and say in the test plan which one, with a fixture that moves a barricade next to a pad.

Restate the C3 owner question with the measured consequence: the strict (base wholly within) reading bars exactly 3 datacards — all EXODITE DRAGON MASTERS on 75×42mm ovals — from teleport pads and therefore from teleporting; every other base in data/teams/** fits, the tightest being 50mm at 0.343\" of slack. Everything else in the plan — derive-don't-cache for C5, C2 being per-board rather than per-player, the killzones.txt:456 justification for one-pad maps, the tomb-world.txt:112-113 FAQ ruling teleport out of the move machinery, the PendingDecision for the enemy swap, and the D-051 note that a teleport rolls no dice and therefore stays undoable — I checked and agree with.

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

### OWNER

TWO, and the first blocks C3.

1. HOW STRICT IS "cannot touch the killzone floor"? The engine already models a pad occupant at z=0.2 and a floor operative at z=0, so in one sense the clause is already satisfied and needs no code. The strict reading — the base must be WHOLLY within the pad polygon — has a hard consequence: measured, the pad is 2.312" square, so a 32mm base has 1.052" of slack, a 40mm 0.737", a 50mm 0.343", and a 75x42mm oval (2.953" long) CANNOT fit at all, which bars every large operative from teleport pads and therefore from teleporting. killzones.txt:217 explicitly permits partial overhang on ordinary Vantage terrain ("so long as part of its base is always on the Vantage terrain"), which is why the pad needed its own sentence — that argues for the strict reading — but the owner should confirm before large operatives lose the mechanic.

2. THE SWAP ORDER when both pads are occupied. killzones.txt:528 says "swap them around (if it's an enemy operative, its controlling player sets it up)", which requires a new PendingDecision kind and an answer to what happens if the opponent has no legal placement (the vacated pad is the only candidate, so in practice it is forced — but the decision channel still has to offer something, and architecture rule 3 forbids assuming the active player does everything).

Nothing in docs/DECISIONS.md D-001..D-102 covers teleport pads. D-002 (Close Quarters applies to Gallowdark AND Tomb World) is adjacent but different — teleport pads are a Tomb World terrain rule at killzones.txt:525-528, inside the KILLZONE: TOMB WORLD section that begins at :455, not part of the Close Quarters block that begins at :532 — so `map.closeQuarters` is the wrong gate for them. Gate on the presence of `role: 'teleportPad'` parts in the terrain index instead.

Also worth recording (not a blocker): the audit's own proposed fix — "set op.onTeleportPadId after every position change (settleZ is the natural home)" — is disproved by the code. `settleZ` is called from only reducer.ts:204 and reducer.ts:564, never from the move path, which sets `op.pos`/`op.z` directly at actions.ts:152-153. Following that plan would have left the field stale after every Reposition. Derive, do not cache.

### Files

`src/core/types.ts`, `src/core/terrain.ts`, `src/core/state.ts`, `src/core/movement.ts`, `src/core/actions.ts`, `src/core/reducer.ts`, `src/core/equipment/kit.ts`, `src/core/equipment/index.ts`, `src/ai/legal.ts`, `src/ui/command/`, `docs/RULES-COVERAGE.md`, `docs/DECISIONS.md`, `tests/rules-review.test.ts`


---

## W-36

*Effort: large · verifier agrees it is live: True · verifier accepts the plan: False*

### Rule

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

### Where the original entry is wrong

Both halves confirmed live, and the marker half is worse than described — but four statements are wrong at HEAD.

(1) "it runs inside inflictDamage, which is called from the middle of shoot and fight sequences — re-entrancy needs care" is FALSE, and this is the claim that set the item's risk. removeIncapacitated is NOT called from inflictDamage. src/core/state.ts:387 inflictDamage only decrements wounds, sets `target.incapacitated = true` and emits onIncapacitated; then it returns. Removal happens at four places, all already safe points: src/core/reducer.ts:411 via removeIncapacitatedAfterAction (reducer.ts:635, which returns early unless `state.sequence.step === 'done'`), src/core/reducer.ts:645 via finishSequenceIfDone (gated on `state.pending.length === 0`), src/core/reducer.ts:433 in EndActivation, and src/core/phases.ts:234 in endTurningPoint. A blocking PendingDecision raised inside removeIncapacitated therefore never re-enters a live dice sequence. The item is meaningfully less risky than "medium-high".

(2) "that also makes the early-return at src/core/ops/tac/stealIntelligence.ts:84 harmless rather than load-bearing" mis-describes the file. The drop-everything loop the audit asks for ALREADY EXISTS, at stealIntelligence.ts:104-108 ("A carrier that dies drops everything it was holding"). It is dead for the case that matters because the handler returns at line 84, `if (!owner || ev.operative.player === owner) return;` — the op module registers per player, so its handler fires only when an operative of the OTHER player is incapacitated; its own carrier is always skipped. Worse, the behaviour is asymmetric: in a mirror game where both players hold Steal Intelligence the opponent's copy DOES drop everything, so the same board position resolves differently depending on the opponent's tac op.

(3) "order multiple dying operatives by their own controller's choice rather than by initiative" mis-reads core-rules.txt:423. The sentence is "that operative's player decides the order of any of ITS RULES that occur before it's removed from the killzone (taking precedence over the player with initiative deciding)" — the ordering is among ONE operative's own rules, not among several dying operatives. And the current order is neither initiative nor player: removeIncapacitated iterates `Object.values(state.operatives)`, i.e. p1-0, p1-1, ..., p2-0 insertion order.

(4) The W-38/D-100 re-read the brief asked for: the audit's description survives intact. src/teams/tempestus-aquilons/index.ts:889-906 still grants GUNFIGHT through grantFreeAction at the ENEMY's onActivationEnd, and helpers.ts grantFreeAction now writes a FREE_ACTION_RULE effect carrying `ap: 1` instead of pushing into aplMods — so "an extra AP on the operative's NEXT activation" and "for a removed operative never occurs" are both still exactly right. The gate that makes it unreachable is src/core/reducer.ts:115, `if (next.activeOperativeId !== op.id) return fail('that operative is not the active operative')`.

(5) Understated: `freeActions: string[]` is too weak a payload for the printed rules. Aquilon Gunfight needs a fixed target and weapon ("it can only target that enemy operative with its hot-shot laspistols (focused)"), Wyrmblade OVERTHROW THE OPPRESSORS offers a free Shoot OR a 0CP ploy, and Death Korps IN DEATH, ATONEMENT / Brood Brother BROODMIND DEVOTION / Sanctifier IMPERIAL CULT DEVOTION all add "and you can change its order to do so". The hook type must grow, not just be consumed.

(6) The affected-rule list is larger than the audit's six teams. Scanning data/teams/*.json for an action granted before removal gives at least eleven rules across nine teams: brood-brother Sapper FINAL DEFIANCE and Iconward BROODMIND DEVOTION; death-korps IN DEATH, ATONEMENT; hearthkyn-salvager WORTH IT; kommandos Bomb Squig BOOM!; sanctifiers Reliquant IMPERIAL CULT DEVOTION; tempestus-aquilons Aquilon Gunfighter GUNFIGHT; wrecka-krew Bomb Squig BOOM!; wyrmblade A PLAN GENERATIONS IN THE MAKING and Icon Bearer OVERTHROW THE OPPRESSORS. Ten team modules already carry a REMINDER_ONLY note naming `onIncapacitated.freeActions` as the missing seam.

### Evidence (run, not read)

THREE runs, all under /tmp/claude-0/-home-user-kill-team-mobile/5881cd81-0f14-5af7-a8ac-da4f6316c520/scratchpad/.

(a) w36b.test.ts — freeActions is written and dropped. A scratch onIncapacitated handler pushes 'Shoot' into ev.freeActions; the operative is killed by inflictDamage and swept by removeIncapacitated:
  inflictDamage -> {"inflicted":99,"incapacitated":true}
  handler observed freeActions = ["Shoot"]        <- the hook CAN write it
  pending decisions raised: []
  victim.incapacitated = true removed = undefined
  opState keys: []
  effects: []
  victim.actionsThisActivation = []
  after removeIncapacitated: removed = true pending = []
  log tail: [ 'A takes 99 damage (-89 wounds left)', 'A is incapacitated', 'A is removed from the killzone' ]
Nothing is recorded anywhere in state — no decision, no effect, no opState entry, no log line.

(b) w36c.test.ts — the marker half, end to end through the reducer, with p1 holding tac.stealIntelligence and the op module's OWN onIncapacitated handler creating the markers:
  intel markers created: [ 'intel-4@15,11', 'intel-9@15.6,11' ]
 …[truncated]

### Plan

Land as TWO commits. (b) first — a handful of lines that stop a permanent VP loss.

COMMIT 1 — place every carried marker.
1. src/core/state.ts, removeIncapacitated (line 426). Replace the `if (op.carryingMarkerId) { ... }` block (lines 429-441) with a sweep over the marker table:
     for (const marker of Object.values(state.markers)) {
       if (marker.carriedBy !== op.id) continue;
       marker.carriedBy = undefined as unknown as string | undefined;
       marker.pos = { ...op.pos };
       marker.z = op.z;
       log(state, { kind: 'action', player: op.player,
         text: `${op.letter} places the ${marker.kind} marker before being removed (0AP)` });
     }
     op.carryingMarkerId = undefined as unknown as string | undefined;
   Keep `op.pos` as the placement point (see ownerDecisionNeeded) and the existing 0AP wording, which already quotes core-rules.txt:301. Iterating markers rather than the operative also repairs the case where a later pick-up overwrote op.carryingMarkerId: src/teams/{phobos-strike-team:1238, spectre-squad:1600, death-korps:1494, goremonger:1846, farstalker-kinband:1812, wolf-scouts:562, xv26-stealth-battlesuits:788} and src/core/ops/tac/retrieval.ts:65 all assign `op.carryingMarkerId = marker.id` unconditionally, while Pick Up Intelligence (stealIntelligence.ts:68) only assigns `if (!op.carryingMarkerId)`.
2. src/core/ops/tac/stealIntelligence.ts: delete the now-redundant, wrong-sided drop loop at lines 104-108 and its comment. Leave the onActivationEnd carry loop at 111-115 — that one is correct and still needed, because applyMove also only moves op.carryingMarkerId.
3. Cheap while in the file: applyMove (src/core/actions.ts, the `if (op.carryingMarkerId)` block) has the same single-marker bug mid-activation. Sweep by carriedBy there too, or leave it and note it.

COMMIT 2 — the pre-removal free action.
4. src/core/hooks.ts:310. Widen the payload:
     export interface IncapacitatedFreeAction { id: string; label: string; ruleId: string; sourceText: string; action: string; params?: ActionParams; order?: 'engage' | 'conceal'; }
     onIncapacitated: { state; operative; prevented: boolean; freeActions: IncapacitatedFreeAction[] };
   Safe: nothing writes it today.
5. src/core/state.ts, inflictDamage (lines 405-417). After the `inc.prevented` branch, if `inc.freeActions.length > 0`, RECORD them — never ask here, this runs inside dice resolution. Use an effect so it is replay-visible and expires:
     effect(state, { rule: 'incapacitatedFreeAction', source: {kind:'ability', id: inc.freeActions[0].ruleId}, operativeId: target.id, player: target.player, data: { actions: inc.freeActions }, expiry: { kind: 'endOfAction' } });
6. src/core/state.ts, removeIncapacitated. After commit 1's marker sweep and BEFORE `op.removed = true`:
     const eff = effectOn(state, op.id, 'incapacitatedFreeAction');
     const acts = (eff?.data?.['actions'] ?? []) as IncapacitatedFreeAction[];
     if (acts.length > 0 && !eff!.data!['offered']) {
       eff!.data!['offered'] = true;
       push(state, { id: `incfree-${state.seq++}`, who: op.player, kind: 'incapacitatedFreeAction', optional: true,
         prompt: `${op.letter} may perform one free action before being removed`,
         options: [...acts.map((a, i) => ({ id: a.id, label: a.label, data: { operativeId: op.id, index: i } })),
                   { id: 'skip', label: 'Remove it now' }],
         sourceText: "Some rules allow an incapacitated operative to perform a free action before being removed from the killzone. Such an operative cannot perform more than one free action (excluding Place Marker) in this instance..." });
       return;                                  // leave this one incapacitated-but-not-removed
     }
   The `offered` flag makes the function idempotent across its four call sites. `return`, not `continue`, because the decision must be answered before any other dying operative is swept, and because core-rules.txt:423 gives the ordering of a dying operative's own rules to its own player.
7. src/core/decisions.ts, resolveDecision switch: add `case 'incapacitatedFreeAction':` which, for a non-'skip' option, looks up the recorded entry, applies `op.order` if the rule allows the change, and performs the action via `getAction(a.action).check/.perform` directly with ap = 0 — NOT through the PerformAction intent, because reducer.ts:115 refuses any operative that is not activeOperativeId and that gate must stay. Mark the effect consumed (`eff.data['used'] = true`) so "cannot perform more than one free action" holds, then call `removeIncapacitated(ctx, state)` again to finish the sweep.
8. src/core/phases.ts:234 (endTurningPoint) needs no change: anything reaching it has already been flagged `offered`, so it force-removes.
9. src/ai/decide.ts: a `case 'incapacitatedFreeAction'` taking the first non-skip option (a free action is free). src/ui/command/index.tsx: one DECISION_LABEL entry. Both one-liners — the generic decision screen renders it.
10. Convert the ten team REMINDER_ONLY entries naming `onIncapacitated.freeActions` into real handlers, ONE TEAM PER COMMIT: start with src/teams/tempestus-aquilons/index.ts (GUNFIGHT emits the recorded free `Shoot (Gunfight)` with the stored targetId; delete the grantFreeAction approximation at 889-906 and the timing note at 228), then src/teams/wrecka-krew and src/teams/kommandos (Bomb Squig BOOM!, the simplest shape).

### Verifier objection — takes precedence over the plan above

LIVE, both halves — I re-ran the investigator's repros. /tmp/.../scratchpad/w36c.test.ts fails exactly as claimed: after the carrier is swept, `intel-4 carriedBy=undefined` but `intel-9 carriedBy=p1-0` (a removed operative), `carriedIntelligence(p1) = []`, and Pick Up Intelligence on it returns "that marker is already being carried" — a permanent, unrecoverable VP loss. /tmp/.../scratchpad/w36b.test.ts confirms `freeActions` is written by a handler and dropped with no decision, effect, opState entry or log line.

I verified the structural corrections and they hold: `inflictDamage` (src/core/state.ts:387-419) only decrements, flags and emits — it never removes; `removeIncapacitated` (state.ts:426-446) places only `op.carryingMarkerId`; stealIntelligence's own-side early return at :83 makes the drop loop at :104-108 wrong-sided and the behaviour asymmetric in mirror games; core-rules.txt:423 verbatim does say "the order of any of ITS rules", so the audit's "order multiple dying operatives" reading is indeed a misread; `grep -rn freeActions src/` = 1 declaration (hooks.ts:310), 1 empty initialiser (state.ts:409), 10 REMINDER_ONLY comments, no reader or writer.

But the plan has four implementability/risk errors, one of which is the exact claim used to downgrade the risk:

(1) THERE ARE SEVEN REMOVAL SITES, NOT FOUR, AND ONE IS UNGATED. `grep -rn removeIncapacitated src/`: reducer.ts:411 (via removeIncapacitatedAfterAction, 635), reducer.ts:433, reducer.ts:645 (via finishSequenceIfDone), phases.ts:234 — PLUS src/teams/void-dancer-troupe/index.ts:863 and :977, src/teams/raveners/index.ts:688, src/teams/tempestus-aquilons/index.ts:665. The plan's risk section says "all four removal sites are already gated on a finished sequence or an empty pending list". void-dancer-troupe:863 (THE CURTAIN FALLS) is gated on neither: it force-sets `seq.step='done'`, filters only `strikeOrBlock` out of `state.pending`, calls `removeIncapacitated`, then unconditionally does `ev.state.sequence = null` and teleports the operative. Under plan step 6 that call returns early with a decision pending and a live casualty, the sequence is nulled anyway, and `finishFight` (:977, gated on `pending.length === 0`) can no longer clean up. raveners:688 and tempestus-aquilons:665 run inside `onEndOfTP`, after endTurningPoint's own sweep.

(2) STEPS 5 AND 6 WOULD MAKE src/core IMPORT src/teams. `effect(...)` and `effectOn(...)` are exported from **src/teams/helpers.ts:227 and :239**, and helpers.ts imports FROM core (`../core/state.ts` at line 24, plus actions/context/geometry/hooks/weaponRules). Calling them from src/core/state.ts inverts the layering CLAUDE.md rule 5 sets up ("the kernel knows no faction") and creates a cycle. The only core-side primitive is `pushEffect` (src/core/hooks.ts:454).

(3) STEP 6's `push(state, {...})` DOES NOT EXIST IN CORE. `push` is a module-private helper duplicated in src/core/sequences/fight.ts:578 and src/core/sequences/shoot.ts:866; `pushOpDecision` (src/core/ops/common.ts:502) is the only exported cousin. state.ts also cannot import decisions.ts — decisions.ts:8 imports state.ts.

(4) `expiry: { kind: 'endOfAction' }` DOES NOT EXPIRE AT THE END OF AN ACTION. The only consumer is `expireEffects`, called from `endTurningPoint` (src/core/phases.ts:242-256). The recorded effect therefore survives to the end of the turning point.

Smaller: the active-operative gate the plan cites as reducer.ts:115 is actually reducer.ts:364 (:115 is inside SelectRoster). And the plan never mentions `onFreeActions` (hooks.ts:67, :318 — `{state, operative, actions: {id,label}[]}`), a SECOND dead free-action seam with no emitter and no consumer; widening `onIncapacitated.freeActions` while leaving that one dead is the silent no-op CLAUDE.md rule 5 forbids.

### Corrected plan

COMMIT 1 (the marker sweep) is right and should ship first — the code change is exactly as described and my run proves the loss it fixes. Two additions: (a) the plan's claim that only Steal Intelligence can put two markers on one operative is worth stating as a checked invariant, since every other `marker.carriedBy = op.id` writer (phobos-strike-team:1238, xv26:788, goremonger:1846, farstalker-kinband:1812, wolf-scouts:562, spectre-squad:1600, death-korps:1494, ops/tac/retrieval.ts, core/actions.ts:342) sets `op.carryingMarkerId` in the same breath; (b) note that deleting stealIntelligence.ts:104-108 moves the drop from inflictDamage time to removeIncapacitated time, so anything reading `marker.carriedBy` between those points changes.

COMMIT 2 needs three fixes before it is buildable:
- Hoist the effect helpers, or do not use them. Either move `effect`/`effectOn` into src/core (re-exporting from src/teams/helpers.ts, the shape helpers.ts:288 already uses for FREE_ACTION_RULE), or write the effect with `pushEffect` (hooks.ts:454) and find it with a plain `state.effects.find(e => e.rule === 'incapacitatedFreeAction' && e.operativeId === op.id)`.
- Name where the decision push comes from: export a `pushDecision(state, d)` from a module state.ts may import (types.ts or a new decisions-free helper) and have fight.ts:578 / shoot.ts:866 delegate to it, rather than writing `push(...)` in state.ts.
- Use `expiry: { kind: 'endOfActivation', operativeId }` or clear the effect explicitly in the resolver; `endOfAction` will not expire when the plan assumes.

Add void-dancer-troupe/index.ts:863 to filesToChange and to the test plan: THE CURTAIN FALLS must not null the sequence and teleport while an `incapacitatedFreeAction` decision is pending. Add raveners:688 and tempestus-aquilons:665 to the audit list even if they turn out to be no-ops (operatives incapacitated for the first time inside `onEndOfTP` never went through inflictDamage, so no effect exists and no decision is raised — state that, do not assume it).

Fix the citation to reducer.ts:364, and say explicitly what happens to `onFreeActions` (hooks.ts:318): fold it into the new payload or delete it, in the same change.

The three owner questions are the right ones and none is covered by an existing entry; add a fourth — whether an incapacitated-but-not-yet-removed operative stays in `aliveOperatives` for control range, marker contest and assists during the new window (core-rules.txt:429 supports it, but it must be written down).

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

### OWNER

Yes — three questions, none covered by an existing entry (docs/DECISIONS.md has nothing on pre-removal; D-022 is the nearest analogue and D-100 governs the free-AP modelling this replaces).

1. WHERE does the forced Place Marker go? core-rules.txt:299/301 says "within its control range", a continuous region, and D-016's precedent is "a killzone position is continuous so it cannot be enumerated as DecisionOptions — use a deterministic, logged default". I recommend keeping the operative's own position (what the code does today, always legal), recorded as a decision. The alternative — a placement decision, which matters when a carrier dies straddling an objective — needs a position channel the engine does not have.

2. Is the pre-removal free action a BLOCKING PendingDecision or an auto-used deterministic policy? D-022 says "'You can use this rule' is auto-used on a stated, deterministic policy when it is free, and raised as a PendingDecision when it costs something". A pre-removal free action IS free (the operative is dying anyway), which argues for auto-use — but Wyrmblade OVERTHROW THE OPPRESSORS is a genuine either/or (a free Shoot, or the A PLAN GENERATIONS IN THE MAKING ploy for 0CP) and Kommandos/Wrecka BOOM! makes the operative shoot its own explosives at a chosen target. My recommendation: a decision, because it is the only pre-removal window in the game and auto-using it would make ten team rules invisible.

3. Retire the D-100/GUNFIGHT approximation in the same change? Today src/teams/tempestus-aquilons/index.ts:889-906 grants free AP at the enemy's end-of-activation and the GUNFIGHTER spends it on its own next activation — which, as its own REMINDER_ONLY at line 228 says, means a GUNFIGHTER killed by that shot never fires back. Fixing the seam makes the approximation unnecessary and wrong (it would double-grant). Retire it, but as its own commit after the seam lands, because it moves the Tempestus Aquilons fixtures.

One rules reading to confirm while deciding: I read "(excluding Place Marker)" in core-rules.txt:423 as licence to place MORE than one marker — Place Marker is carved out of the one-free-action cap, and the Steal Intelligence op text explicitly contemplates carrying two. That is the textual basis for commit 1 placing every carried marker rather than one, and it should be recorded.

### Files

`src/core/state.ts`, `src/core/hooks.ts`, `src/core/decisions.ts`, `src/core/ops/tac/stealIntelligence.ts`, `src/core/actions.ts`, `src/ai/decide.ts`, `src/ui/command/index.tsx`, `src/teams/tempestus-aquilons/index.ts`, `src/teams/wrecka-krew/index.ts`, `src/teams/kommandos/index.ts`, `tests/rules-review.test.ts`, `tests/ops.test.ts`, `docs/DECISIONS.md`, `docs/RULES-AUDIT.md`
