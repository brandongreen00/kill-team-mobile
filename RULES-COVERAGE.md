# Kill Team 2024 rules coverage

Status of the KT24 (kill-team3) core rules in this app, checked against
wahapedia.ru/kill-team3 (core book incl. 2025 updates, Approved Ops 2025,
Killzone: Tomb World). Updated 2026-07.

## Implemented

### Game structure
- 4 turning points; game ends after TP4, most VP wins (draws possible).
- Strategy phase: per-TP initiative roll-off (ties go to the player
  *without* initiative — AO2025 rule), CP generation (2CP at battle start,
  +1CP per TP, 2CP for the non-initiative player from TP2), ready-up.
- Firefight phase: alternating activations; **Counteract** when one side is
  expended (free 1AP action, Engage order, max 2" move, once per operative
  per TP); the game plays out remaining activations correctly.

### Actions
- Reposition / Dash / Charge (+2", must end in control range) / Fall Back
  (2AP) with waypoint pathing, wall-swept base collision, control-range
  rules per action, and **move increments rounded up to whole inches**.
- Shoot / Fight with the same-action-once-per-activation restriction.
- **Guard** (1AP, treated as a Shoot action): interrupts an enemy
  activation after any of their actions with a free Shoot or Fight.
- Tomb World: Operate Hatch (1AP), Breach (2AP, 1AP for grenadier-types)
  **with far-side concussion** (4+: half-roll damage and -1 APL),
  teleport pads (TP2+), Close Quarters Lethal 5+ for Blast/Torrent.
- Mission actions: Secure / Loot / Initiate Transmission (crit ops),
  Plant Device / Scout (tac ops) — surfaced contextually in the action grid.

### Shooting / fighting math
- Full universal weapon-rule list: Accurate x, Balanced, Blast x", Brutal,
  Ceaseless, Devastating x (unblockable, die still resolves; melee too),
  Heavy*, Hot (post-use D6, result×2 self-damage), Lethal x+, Limited
  (loadout layer), Piercing x / Piercing Crits x (**remove defence dice**),
  Punishing, Range x", Relentless, Rending, Saturate, Severe (doesn't
  enable Rending/Punishing), Shock, Silent (shoot on Conceal), Stun
  (-1 APL until end of target's next activation), Torrent x".
- Blast/Torrent resolve secondary-target sequences after the primary.
- Cover: intervening light terrain within 1" of the target, negated within
  2" of the shooter; cover save = one retained normal success.
- Defence: 3 dice, crit on 6; optimal or manual allocation (two normals
  block a crit when shooting; **not** in melee).
- Fight: alternating strike/block, crit blocks crit-or-normal, normal
  blocks normal, Brutal forces crit-only blocks; assists not yet modelled.
- Injured: -2" Move (4" floor) and worsened Hit everywhere.
- APL modifiers clamped to ±1; used for activation AP and marker control.
- Weapon Range enforced for target selection; no shooting at enemies that
  have friendlies within their control range.
- Command Re-roll (1CP) inside both dice dialogs.

### Ops & scoring (Approved Ops shape)
- **Kill Op**: official kill-grade table + end-of-battle higher-grade bonus.
- **Crit Op** (shared, selectable or random): Secure, Loot, Transmission
  with their mission actions and end-of-TP scoring (6VP cap).
- **Tac Ops** (secret, per-side, filtered to the faction's archetypes —
  all 44 teams' archetypes verified against wahapedia): Rout, Dominate
  (Seek & Destroy), Martyrs, Envoy (Security), Flank, Scout Enemy Movement
  (Recon), Track Enemy, Plant Devices (Infiltration). Automated scoring
  with per-TP and 6VP caps.
- Ploys: faction strategy/firefight ploys browsable in the Ploys & CP
  sheet; CP costs enforced, once-per-TP enforced, usage logged and shown —
  their *effects* are reminders for the players (not auto-applied).
- Equipment: each side secretly brings up to 4 options (team screen);
  shown with full text in the Ploys & CP sheet during the battle.

## Not yet implemented (roadmap, roughly in priority order)

1. **Equipment effects as mechanics** — selection (up to 4 per side) and
   in-battle reminders exist; auto-applying common effects (re-rolls,
   extra weapons) can follow.
2. **Faction rules / ploy effects as mechanics** — the effect IDs in
   factions.js (`attacker_effects` / `defender_effects`) suggest a generic
   buff engine (e.g. `*_ceaseless` grants Ceaseless for a sequence).
3. **Obscured (Heavy terrain)** — discard one success + crits downgraded;
   the Tomb World wall model treats walls as LoS-blocking instead, which is
   close but not exact near wall ends. Vantage is also out (flat board).
4. **Remaining universal tac ops** (Plant Banner, Steal Intelligence,
   Retrieval, Sweep & Clear) — need marker carrying (Pick Up / Place
   Marker actions), which is also a prerequisite for the Energy Cells /
   Orb / Data / Reboot / Stake Claim / Download crit ops.
5. **AO2025 initiative cards** and the **Primary Op** (half-again bonus).
6. **Fight assists** (+1 Hit per assisting friendly) and Guard point-blank
   shots (shoot while in control range at worsened Hit).
7. **Missing teams**: Hearthkyn Salvagers and Spectre Squad (May 2026) are
   not in factions.js; pull from upstream when available.
8. Hatchway Fight (fight through an open hatchway within 2"), Operate
   Hatch during Reposition/Dash.
9. AI: play more teams well (currently tuned for Plague Marines), use
   ploys/CP, guard, and teleporters.
