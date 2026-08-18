# TEAM DATA

`data/teams/**` — every Warhammer 40,000 Kill Team (3rd ed / KT24) kill team, scraped from
wahapedia.ru and curated into the types in `src/core/types.ts`. **48 teams,
454 datacards, 49 rare weapon rules.**

This document is the contract a `src/teams/<slug>/index.ts` module codes against, plus an
honest list of everything the source did not give us. Pipeline mechanics (selectors, cache,
flags) live in `tools/teams/README.md`.

## Regenerating

```bash
python3 tools/teams/scrape_wahapedia.py           # wahapedia.ru -> .cache/wahapedia/ (gitignored)
python3 tools/teams/normalise.py                  # .cache -> data/teams/**
python3 tools/teams/validate.py                   # lint; exit 1 on a real problem
python3 tools/teams/diff_report.py --tables <dir> # the generated tables in §3, §6 and §7
```

Source of truth is Wahapedia's KT3 pages. Where the old app's `public/legacy/factions.js`
disagrees, **Wahapedia wins** — §7 lists every difference, and they are all either stale
values or omissions in the old file.

---

## 1. Per-team file

`data/teams/<slug>.json`, one per team, plus two generated indexes:

| File | Contents |
| --- | --- |
| `data/teams/<slug>.json` | the team (below) |
| `data/teams/_index.json` | slug → name / faction / archetypes / counts, for the team picker |
| `data/teams/_rare-weapon-rules.json` | every non-universal weapon rule with its verbatim definition |

Abridged example (`kasrkin`, trimmed to one of each kind of thing):

```jsonc
{
  "id": "kasrkin",
  "name": "Kasrkin",
  "faction": "Astra Militarum",
  "grandFaction": "Imperium",
  "archetypes": [
    "Seek & Destroy",
    "Security"
  ],
  "booksVersion": "APRIL ’26",
  "sourceUrl": "https://wahapedia.ru/kill-team3/kill-teams/kasrkin/",
  "scrapedAt": "2026-08-17T04:05:21+00:00",
  "source": "cache",
  "selection": {
    "leader": {
      "role": "SERGEANT",
      "datacardId": "kasrkin.sergeant",
      "count": 1,
      "loadoutMode": "choice",
      "inList": false
    },
    "slots": 9,
    "totalOperatives": 10,
    "groups": [
      {
        "index": 1,
        "count": 1,
        "kind": "fixed",
        "roles": [
          "SERGEANT"
        ],
        "rawText": "1 KASRKIN SERGEANT operative with one of the following options:"
      }
    ],
    "list": [
      {
        "role": "GUNNER",
        "datacardAnchor": "Kasrkin-Gunner",
        "count": 1,
        "fixedWeapons": [
          "Flamer",
          "Gun butt"
        ],
        "fixedChoiceGroups": [],
        "loadouts": [],
        "optionGroups": [],
        "loadoutMode": "fixed",
        "selectionCost": 1,
        "footnoteGroup": "*",
        "requires": [],
        "rawText": "GUNNER with flamer and gun butt*",
        "group": 2,
        "datacardId": "kasrkin.gunner",
        "isLeader": false,
        "uniqueUnlessRole": true,
        "alwaysWeapons": []
      }
    ],
    "constraints": [
      {
        "kind": "uniqueExcept",
        "roles": [
          "TROOPER"
        ]
      },
      {
        "kind": "groupCap",
        "group": "*",
        "max": 4
      }
    ],
    "footnotes": {
      "*": "You cannot select more than four of these operatives combined."
    },
    "designerNotes": [
      "Some KASRKIN rules refer to a ‘hot-shot weapon’. This is a ranged weapon that includes ‘hot-shot’ in its name, e.g. hot-shot lasgun, all profiles of a hot-shot marksman rifle, etc."
    ],
    "rawText": "…verbatim Operatives section…"
  },
  "datacards": [
    {
      "id": "kasrkin.sergeant",
      "teamId": "kasrkin",
      "name": "Kasrkin Sergeant",
      "keywords": [
        "KASRKIN",
        "IMPERIUM",
        "ASTRA MILITARUM",
        "LEADER",
        "SERGEANT"
      ],
      "base": {
        "shape": "round",
        "mm": 28
      },
      "apl": 3,
      "move": 6,
      "save": 4,
      "wounds": 9,
      "weapons": [
        {
          "name": "Chainsword",
          "profiles": [
            {
              "type": "melee",
              "atk": 4,
              "hit": 3,
              "dmgN": 4,
              "dmgC": 5,
              "rules": []
            }
          ]
        }
      ],
      "abilities": [
        {
          "id": "kasrkin.sergeant.veteran-leadership",
          "name": "Veteran Leadership",
          "text": "Whenever this operative is in the killzone and you use the SKILL AT ARMS STRATEGIC GAMBIT, you can select one additional SKILL AT ARMS but they cannot be the same."
        }
      ],
      "uniqueActions": [
        {
          "id": "kasrkin.sergeant.act.tactical-command",
          "name": "TACTICAL COMMAND",
          "ap": 0,
          "text": "Select one friendly KASRKIN operative, then select one SKILL …"
        }
      ]
    }
  ],
  "factionRules": [
    {
      "id": "kasrkin.rule.rapid-fire",
      "name": "Rapid Fire",
      "text": "Each friendly KASRKIN operative that doesn’t perform an action in whic …",
      "fluff": "…"
    }
  ],
  "strategyPloys": [
    {
      "id": "kasrkin.sp.elimination-pattern",
      "name": "ELIMINATION PATTERN",
      "text": "…",
      "cp": 1,
      "fluff": "…"
    }
  ],
  "firefightPloys": "… 4 of them …",
  "equipment": [
    {
      "id": "kasrkin.eq.combat-daggers",
      "name": "COMBAT DAGGERS",
      "text": "…",
      "fluff": "…",
      "weapons": [
        {
          "name": "Combat dagger",
          "profiles": [
            {
              "type": "melee",
              "atk": 3,
              "hit": 4,
              "dmgN": 3,
              "dmgC": 4,
              "rules": []
            }
          ]
        }
      ]
    }
  ],
  "rareWeaponRules": [
    "ConcealedPosition"
  ],
  "markerGuide": "…",
  "notes": []
}
```

### Field reference

| Path | Meaning |
| --- | --- |
| `id` | the Wahapedia slug — the filename, and the `teamId` on every datacard |
| `name` / `faction` / `grandFaction` | from the site nav (`div.factionGroup_KT` / `div.FactionHeader`) |
| `archetypes` | `div.archetype`, verbatim. Two teams are not a fixed pair: `inquisitorial-agent` is `["Any"]` and `blades-of-khaine` is `["*"]` (its second archetype follows the Aspect chosen) |
| `booksVersion` / `books` | the Books table. `booksVersion` is the Faction row's Version cell, falling back to its Last update where the page leaves Version empty (8 teams do) |
| `sourceUrl` / `scrapedAt` / `source` | provenance. `source` ∈ `network` / `cache` / `seed` / `context-pack` |
| `selection` | §5 |
| `datacards[]` | `Datacard[]` exactly as declared in `src/core/types.ts` (plus optional `fluff`, `footnotes`) |
| `factionRules[]` / `strategyPloys[]` / `firefightPloys[]` / `equipment[]` | `{ id, name, text, fluff?, weapons?, cp? }`. Ploys carry `cp: 1` (KT24 prints no CP on team ploys; all cost 1CP). `weapons[]` appears where the block hands one out — the Kasrkin `COMBAT DAGGERS` equipment above |
| `markerGuide` | the team's Marker/Token Guide, verbatim |
| `rareWeaponRules[]` | the rare rule ids this team's weapons use — the set a module must `registerRareWeaponRule` |
| `notes[]` | anything the source did not resolve. **An empty array means nothing was left unresolved** — §6 |

Names, rule text and ability text are **verbatim**; nothing is paraphrased or invented.

---

## 2. Datacards

`datacards[]` deserialises straight into `Datacard`:

* `base` is a `BaseShape` — `{"shape":"round","mm":32}` or `{"shape":"oval","mm":[60,35]}`.
  Flying bases keep `note: "flying base"` (six T'au drones); the old file recorded only ⌀32mm.
* `apl` / `move` / `save` / `wounds` are integers, `move` in inches. It is `0` on exactly one
  operative (`spectre-squad` Vox-Relay Beacon) — that is what the page prints.
* `weapons[]` groups the printed rows: `Name (a)` and `Name (b)` become **one** `Weapon` with
  two `WeaponProfile`s. A weapon whose ranged and melee rows share one printed name
  (Sanctifiers' *Brazier of holy fire*) becomes one weapon with two unnamed profiles that
  differ by `type` — faithful to the card.
* `dmgN` / `dmgC` are integers. Two weapons print a non-numeric DMG resolved by their own rule
  (`wrecka-krew` Tankhammer `*`, Pulsa rokkit `-`); both record `0` plus a team `note`.
* `abilities[]` / `uniqueActions[]` are `AbilityDef[]` / `UniqueActionDef[]`. Footnote markers
  are stripped from ability names (`*Shield` → `Shield`); the link back to the weapon lives in
  the rule's `raw` (`"Shield*"`) and in the rare-rule registry.
* `footnotes[]` (optional) holds datacard footnote *notes* that clarify a universal rule rather
  than define a new one — Kommandos' `*Note that Torrent 0" means you cannot select secondary
  targets, but this weapon still has the Torrent weapon rule…`.

---

## 3. Weapon rules

Every WR token becomes a `WeaponRule { id, x?, dist?, only?, raw }`. `raw` is always the
verbatim token, so nothing is lost even where the parse is coarse.

**The 23 universal rules** (Appendix › WEAPON RULES) map to these ids:

`Accurate` `Balanced` `Blast` `Brutal` `Ceaseless` `Devastating` `Heavy` `Hot` `Lethal`
`Limited` `Piercing` `PiercingCrits` `Punishing` `Range` `Relentless` `Rending` `Saturate`
`Seek` `SeekLight` `Severe` `Shock` `Silent` `Stun` `Torrent`

Parsed sub-forms:

| Printed | Parsed |
| --- | --- |
| `Range 9"` | `{id:"Range", x:9}` |
| `Lethal 5+` | `{id:"Lethal", x:5}` |
| `Piercing Crits 1` | `{id:"PiercingCrits", x:1}` |
| `Seek Light` | `{id:"SeekLight"}` |
| `Heavy (Dash only)` | `{id:"Heavy", only:"Dash"}` (two weapons print `Heavy (Dash Only)` — case folded) |
| `1" Devastating 3` | `{id:"Devastating", x:3, dist:1}` |
| `Torrent 0"` | `{id:"Torrent", x:0}` — no secondary targets, but the weapon still *has* Torrent |
| `Poison*` | `{id:"Poison", raw:"Poison*"}` — a rare rule; the `*` links it to its definition |

**Every token that is not one of the 23 goes into `data/teams/_rare-weapon-rules.json`**, with
the teams that use it and the verbatim definition. Nothing is dropped and nothing becomes
`_unknown`; `validate.py` fails the build if a rule id is neither universal nor registered.
Definitions resolve in order from: a datacard ability of the same name (the `*Shield` /
`^1Twin Torrent` footnote form) → a faction rule of the same name → the page's tooltip glossary.

| Rule id | Printed as | Teams | Definition source |
| --- | --- | --- | --- |
| `Aimed` | `Aimed*` | 1 | exodite-dragon-masters: datacard ability (Dragon Master Leystalker) |
| `AntiPSYKER` | `Anti-PSYKER*` | 2 | novitiates: datacard ability (Novitiate Condemnor) |
| `Beam` | `Beam*` | 1 | hearthkyn-salvager: datacard ability (Hearthkyn Gunner) |
| `Bipod` | `Bipod*` | 1 | hernkyn-yaegir: datacard ability (Yaegir Gunner) |
| `Blaze` | `Blaze*` | 1 | sanctifiers: faction rule |
| `BloodOffering` | `Blood Offering*` | 1 | blooded: datacard ability (Traitor Butcher) |
| `ConcealedPosition` | `Concealed Position*` | 9 | brood-brother: datacard ability (Brood Brother Sniper) |
| `Crush` | `Crush*` | 1 | raveners: datacard ability (Ravener Wrecker) |
| `Custom` | `Custom*` | 1 | phobos-strike-team: datacard ability (Infiltrator Veteran) |
| `Detonate` | `Detonate*` | 4 | death-korps: datacard ability (Death Korps Sapper) |
| `DimensionalBanishment` | `Dimensional Banishment*` | 1 | canoptek-circle: datacard ability (Canoptek Tomb Crawler) |
| `Drag` | `Drag*` | 1 | goremonger: datacard ability (Goremonger Impaler) |
| `Engineered` | `Engineered*` | 1 | gellerpox-infected: datacard ability (Vulgrar Thrice-Cursed) |
| `Explosive` | `Explosive*` | 2 | kommandos: datacard ability (Kommando Bomb Squig) |
| `Feast` | `Feast*` | 1 | gellerpox-infected: datacard ability (Cursemite) |
| `Flay` | `Flay*` | 1 | hand-of-the-archon: datacard ability (Kabalite Flayer) |
| `ForceImpact` | `Force Impact*` | 1 | hearthkyn-salvager: datacard ability (Hearthkyn Jump Pack Warrior) |
| `Headtaker` | `Headtaker*` | 1 | fellgor-ravager: datacard ability (Fellgor Gorehorn) |
| `HumblingCruelty` | `Humbling Cruelty*` | 1 | void-dancer-troupe: datacard ability (Death Jester) |
| `Hypersense` | `Hypersense*` | 1 | wyrmblade: datacard ability (Kelermorph) |
| `Magnify` | `Magnify*` | 1 | hierotek-circle: faction rule |
| `Mindburn` | `Mindburn*` | 1 | warpcoven: datacard ability (Sorcerer of Warpfire) |
| `NeutronBombardment` | `Neutron Bombardment*` | 1 | vespid-stingwings: datacard ability (Vespid Skyblast) |
| `NeutronFragment` | `Neutron Fragment*` | 1 | vespid-stingwings: datacard ability (Vespid Longsting) |
| `PSYCHIC` | `PSYCHIC` | 9 | **no printed definition** — referenced by other rules |
| `PhaseSweep` | `Phase Sweep*` | 1 | deathwatch: datacard ability (Deathwatch Blademaster Veteran) |
| `Poison` | `Poison*` | 2 | plague-marines: faction rule |
| `Prey` | `Prey*` | 1 | goremonger: datacard ability (Goremonger Impaler) |
| `Pulsa` | `Pulsa*` | 1 | wrecka-krew: datacard ability (Tankbusta Rokkiteer) |
| `Repress` | `Repress*` | 1 | exaction-squad: faction rule |
| `Riposte` | `Riposte*` | 1 | novitiates: datacard ability (Novitiate Duellist) |
| `Ritual` | `Ritual*` | 1 | goremonger: datacard ability (Goremonger Bloodtaker) |
| `Salvo` | `Salvo*` | 3 | farstalker-kinband: datacard ability (Kroot Pistolier) |
| `Shield` | `Shield*` | 5 | blooded: datacard ability (Traitor Trench Sweeper) |
| `SiphonLife` | `Siphon Life*` | 1 | legionary: datacard ability (Legionary Balefire Acolyte) |
| `Skytorch` | `Skytorch*` | 1 | vespid-stingwings: datacard ability (Vespid Swarmguard) |
| `Smash` | `Smash*` | 1 | wrecka-krew: datacard ability (Breaka Boy Krusha) |
| `Soulstrike` | `Soulstrike*` | 1 | mandrakes: faction rule |
| `Stalk` | `Stalk*` | 1 | blooded: datacard ability (Traitor Flenser) |
| `Stinger` | `Stinger*` | 1 | hand-of-the-archon: datacard ability (Kabalite Disciple of Yaelindra) |
| `Swipe` | `Swipe*` | 1 | gellerpox-infected: datacard ability (Bloatspawn) |
| `TactualHunter` | `Tactual Hunter*` | 1 | fellgor-ravager: datacard ability (Fellgor Mangler) |
| `Tangle` | `Tangle*` | 1 | hand-of-the-archon: datacard ability (Kabalite Crimson Duellist) |
| `Terrorchem` | `Terrorchem*` | 1 | nemesis-claw: datacard ability (Night Lord Fearmonger) |
| `Toxic` | `Toxic*` | 1 | plague-marines: datacard ability (Plague Marine Champion) |
| `TwinTorrent` | `Twin Torrent^1` | 1 | sanctifiers: datacard ability (Sanctifier Conflagrator) |
| `ViciousBlows` | `Vicious Blows*` | 1 | fellgor-ravager: datacard ability (Fellgor Vandal) |
| `Wreathed` | `Wreathed^1` | 1 | sanctifiers: datacard ability (Sanctifier Miraculist) |
| `ZealousRage` | `Zealous Rage*` | 1 | novitiates: datacard ability (Novitiate Penitent) |

`PSYCHIC` is the one rule with **no printed definition anywhere** — it is a tag read by other
rules (Anti-PSYKER, Weapons of the Witch Hunters, Aspect Techniques…). Its registry entry
carries a `referencedIn` list pointing at those rules instead of a definition.

---

## 4. Ploys and equipment

All 48 teams have exactly **4 strategy ploys, 4 firefight ploys and 4 equipment
options**. `validate.py` reports (does not fail on) any team that differs; today none do.

Ploy and equipment **names are UPPERCASE** because Wahapedia prints them that way; the old
`factions.js` title-cased them. That is a display choice, not a data difference.

---

## 5. `selection` — the structured kill-team selection

The Operatives section is prose wrapped around a two-level `<ul>`. It is parsed into structure
so no team module has to read English at runtime.

| Field | Meaning |
| --- | --- |
| `leader` | the leader slot: `role` (or `null` with several `choices`), `datacardId`, `count`, `loadouts`, `optionGroups`, `loadoutMode`, `fixedWeapons`, `alwaysWeapons`, `inList` |
| `leader.inList` | `true` when the leader is picked out of a mixed list and therefore **consumes an ordinary slot** (Deathwatch, Wolf Scouts, Elucidian Starstrider, Gellerpox Infected) |
| `slots` | operatives to select **besides** a dedicated leader slot |
| `totalOperatives` | every group's count summed — the kill team's size |
| `groups[]` | the printed groups: `{index, count, kind, roles[], rawText}`. `kind` ∈ `fixed` (one named role) · `list` (choose from a list) · `every` (a fixed roster — "Every X operative in the following list") · `sameAsAbove` (Inquisitorial Agent's second block) |
| `list[]` | one entry per selectable role (below) |
| `leaderList[]` | the entries whose datacard carries `LEADER`, for teams where that overlaps `list` |
| `constraints[]` | machine-readable restrictions (below) |
| `footnotes[]` | marker → verbatim footnote text |
| `footnoteOptions` | marker → `{text, fixedWeapons, loadouts}` where a footnote *defines a loadout* ("`*`With one of the following options:" — Hearthkyn Salvager, Warpcoven) |
| `designerNotes[]` | the `div.Corner25` designer's-note boxes, kept out of the constraint set |
| `rawText` | the verbatim Operatives section, so the parse can always be checked by eye |

### Entry fields

| Field | Meaning |
| --- | --- |
| `role` | printed role keywords with the faction keyword dropped: `KASRKIN GUNNER` → `GUNNER` |
| `datacardId` / `datacardAnchor` | resolved datacard; the anchor is the page's own `#link` |
| `count` | how many this entry places (`2 PSYCHIC FAMILIAR operatives`) |
| `selectionCost` | `1` normally; `2`/`3` for `(counts as two|three selections)`; `0.5` for `count as half a selection each` |
| `fixedWeapons[]` | weapons the printed entry names (`GUNNER with meltagun and gun butt`) |
| `fixedChoiceGroups[]` | inline `A or B` alternatives inside a fixed list |
| `loadouts[]` | `{id, label, weapons[], choiceGroups?, items?, footnoteGroup?}` — pick **one** |
| `optionGroups[]` | `{id, label, choices[]}` — pick **one from each** |
| `loadoutMode` | `fixed` (no choice) · `choice` (one of `loadouts`) · `combine` (one from each `optionGroup`) · `either` (`loadouts` **XOR** one-from-each-`optionGroup`, printed as "… Or one option from each of the following") |
| `alwaysWeapons[]` | **every datacard weapon not named in any selection option of that datacard** — always available. The core selection rule, made explicit: the Navis Grenadier keeps its demolition charge (Limited 1), both Navis shotgun profiles and its Navis hatchet with no choice to make |
| `uniqueUnlessRole` | `true` when the team's "each operative once" rule applies to this role |
| `requires[]` | roles this entry needs in the team (`GHEISTSKULL` → `VOID-JAMMER`) |
| `footnoteGroup` | the `*` / `^1` marker this entry carries |
| `items[]` on an option | printed loadout components that are **not** datacard weapons (Blades of Khaine `Shimmershield`, Sanctifiers `holy relic`) — kept verbatim rather than dropped |
| `rawText` | the verbatim `<li>` text |

`alwaysWeapons` is pooled **per datacard**, not per entry, so the five Kasrkin `GUNNER` rows
(each naming a different special weapon) correctly leave the Gunner with nothing extra, while
the Navis Grenadier — named in no option at all — keeps everything.

### Constraint kinds

| `kind` | Shape | Printed as |
| --- | --- | --- |
| `uniqueExcept` | `{roles[]}` | "Other than TROOPER operatives, your kill team can only include each operative on this list once" (`roles: []` for the unconditional form) |
| `maxCount` | `{role, max}` | "can only include up to two GUNNER operatives" |
| `maxItem` | `{item, max, group?}` | "up to one fusion pistol", "up to two darklight weapons" |
| `distinctOptions` | `{role}` | "(each must have a different option)" |
| `groupCap` | `{group, max}` | "`*` You cannot select more than four of these operatives combined" |
| `halfSelection` | `{group, max}` | "`*` These operatives count as half a selection each" |
| `selectionCost` | `{group, cost}` | "These operatives count as two selections each" |
| `requires` | `{role, requiresRole}` | "can only include a C.A.T. UNIT operative if it also includes a SURVEYOR operative" |
| `exclusive` | `{group, text}` | "`^2` You cannot select this option and this operative" |
| `exclusiveItems` | `{items[]}` | "Your kill team cannot include both a blaster and a wraithcannon" |
| `custom` | `{text, hook}` | anything not expressible above — **the team module must implement `hook`** |

### `custom` constraints needing a team-module hook (6)

| Team | Hook | Verbatim rule |
| --- | --- | --- |
| `blooded` | `blooded.in-other-words-you-can-only` | In other words, you can only have one operative with a plasma weapon. |
| `brood-brother` | `brood-brother.if-one-of-these-operatives-is` | If one of these operatives is selected for deployment, your COMMANDER operative loses the LEADER keyword for the battle. |
| `brood-brother` | `brood-brother.note-that-counts-as-selections-still` | Note that ‘counts as’ selections still apply; for example, if you select a PATRIARCH operative, you could not do this. |
| `gellerpox-infected` | `gellerpox-infected.if-you-selected-the-mutoid-vermin` | If you selected the MUTOID VERMIN faction equipment: |
| `inquisitorial-agent` | `inquisitorial-agent.your-kill-team-including-any-requisitioned` | Your kill team (including any REQUISITIONED operatives) cannot include more than one weapon with the Piercing 2 weapon rule, and cannot include more than three weapons with the Piercing X (excluding Piercing Crits X) weapon rule combined. |
| `warpcoven` | `warpcoven.you-must-select-at-least-one` | You must select at least one friendly SORCERER operative. |

---

## 6. Per-team coverage

| # | Team | Faction | Archetypes | Cards | Total ops | Leader | SP/FP/EQ | Rare rules | Source version |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `angel-of-death` | Space Marines | Seek & Destroy / Security | 9 | 6 | 3 choices | 4/4/4 | — | January ’26 |
| 2 | `battleclade` | Adeptus Mechanicus | Infiltration / Recon | 7 | 10 | TECHNOARCHEOLOGIST | 4/4/4 | — | APRIL ’26 |
| 3 | `blades-of-khaine` | Craftworlds | * | 6 | 8 | DIRE AVENGER EXARCH | 4/4/4 | — | APRIL ’26 |
| 4 | `blooded` | Cultists | Seek & Destroy / Infiltration | 13 | 14 | CHIEFTAIN | 4/4/4 | 3 | APRIL ’26 |
| 5 | `brood-brother` | Genestealer Cults | Security / Infiltration | 15 | 13 | COMMANDER | 4/4/4 | 2 | February ’26 |
| 6 | `canoptek-circle` | Necrons | Security / Recon | 5 | 8 | GEOMANCER | 4/4/4 | 1 | APRIL ’26 |
| 7 | `celestian-insidiants` | Adepta Sororitas | Seek & Destroy / Security | 8 | 9 | SUPERIOR | 4/4/4 | 2 | January ’26 |
| 8 | `chaos-cult` | Cultists | Seek & Destroy / Infiltration | 7 | 14 | CULT DEMAGOGUE | 4/4/4 | 1 | June ’25 |
| 9 | `corsair-voidscarred` | Corsairs | Infiltration / Recon | 11 | 9 | FELARCH | 4/4/4 | 1 | January ’26 |
| 10 | `death-korps` | Astra Militarum | Seek & Destroy / Security | 12 | 14 | WATCHMASTER | 4/4/4 | 2 | APRIL ’26 |
| 11 | `deathwatch` | Space Marines | Seek & Destroy / Security | 11 | 5 | WATCH SERGEANT (in list) | 4/4/4 | 2 | January ’26 |
| 12 | `elucidian-starstrider` | Agents of the Imperium | Security / Recon | 7 | 10 | ELUCIA VHANE (in list) | 4/4/4 | — | APRIL ’26 |
| 13 | `exaction-squad` | Agents of the Imperium | Seek & Destroy / Security | 12 | 11 | PROCTOR-EXACTANT | 4/4/4 | 2 | January ’26 |
| 14 | `exodite-dragon-masters` | Exodites | Seek & Destroy / Recon | 4 | 5 | — | 4/4/4 | 2 | July 2026 |
| 15 | `farstalker-kinband` | T’au Empire | Infiltration / Recon | 11 | 12 | KILL-BROKER | 4/4/4 | 2 | July 2026 |
| 16 | `fellgor-ravager` | Cultists | Seek & Destroy / Recon | 11 | 10 | IRONHORN | 4/4/4 | 4 | November ’25 |
| 17 | `gellerpox-infected` | Chaos Daemons | Seek & Destroy / Security | 9 | 12 | VULGRAR THRICE-CURSED (in list) | 4/4/4 | 3 | October ’25 |
| 18 | `goremonger` | World Eaters | Seek & Destroy / Recon | 7 | 8 | BLOOD HERALD | 4/4/4 | 3 | November ’25 |
| 19 | `hand-of-the-archon` | Drukhari | Seek & Destroy / Recon | 9 | 9 | ARCHSYBARITE | 4/4/4 | 3 | January ’26 |
| 20 | `hearthkyn-salvager` | Leagues of Votann | Security / Recon | 11 | 10 | THEYN | 4/4/4 | 2 | APRIL ’26 |
| 21 | `hernkyn-yaegir` | Leagues of Votann | Seek & Destroy / Infiltration | 8 | 10 | THEYN | 4/4/4 | 2 | November ’25 |
| 22 | `hierotek-circle` | Necrons | Security / Recon | 9 | 8 | 3 choices | 4/4/4 | 1 | APRIL ’26 |
| 23 | `hunter-clade` | Adeptus Mechanicus | Seek & Destroy / Recon | 14 | 10 | 4 choices | 4/4/4 | — | January ’26 |
| 24 | `imperial-navy-breacher` | Agents of the Imperium | Seek & Destroy / Security | 11 | 11 | SERGEANT-AT-ARMS | 4/4/4 | 2 | January ’26 |
| 25 | `inquisitorial-agent` | Agents of the Imperium | Any | 18 | 12 | INTERROGATOR | 4/4/4 | — | June 2026 |
| 26 | `kasrkin` | Astra Militarum | Seek & Destroy / Security | 8 | 10 | SERGEANT | 4/4/4 | 1 | APRIL ’26 |
| 27 | `kommandos` | Orks | Seek & Destroy / Infiltration | 11 | 10 | BOSS NOB | 4/4/4 | 2 | APRIL ’26 |
| 28 | `legionary` | Chaos Space Marines | Seek & Destroy / Security | 10 | 6 | 2 choices | 4/4/4 | 2 | October ’25 |
| 29 | `mandrakes` | Drukhari | Infiltration / Recon | 6 | 9 | NIGHTFIEND | 4/4/4 | 1 | January ’26 |
| 30 | `murderwing` | Chaos Space Marines | Seek & Destroy / Recon | 9 | 6 | CHAOS LORD | 4/4/4 | — | June 2026 |
| 31 | `nemesis-claw` | Chaos Space Marines | Seek & Destroy / Infiltration | 8 | 6 | VISIONARY | 4/4/4 | 1 | June 2026 |
| 32 | `novitiates` | Adepta Sororitas | Security / Recon | 12 | 10 | SUPERIOR | 4/4/4 | 3 | APRIL ’26 |
| 33 | `pathfinders` | T’au Empire | Infiltration / Recon | 16 | 12 | SHAS’UI | 4/4/4 | — | January ’26 |
| 34 | `phobos-strike-team` | Space Marines | Infiltration / Recon | 13 | 6 | 3 choices | 4/4/4 | 2 | November ’25 |
| 35 | `plague-marines` | Death Guard | Seek & Destroy / Security | 7 | 6 | CHAMPION | 4/4/4 | 3 | APRIL ’26 |
| 36 | `ratlings` | Astra Militarum | Security / Infiltration | 13 | 11 | FIXER | 4/4/4 | — | APRIL ’26 |
| 37 | `raveners` | Tyranids | Seek & Destroy / Infiltration | 6 | 5 | PRIME | 4/4/4 | 2 | November ’25 |
| 38 | `sanctifiers` | Agents of the Imperium | Seek & Destroy / Security | 11 | 11 | CONFESSOR | 4/4/4 | 3 | February ’26 |
| 39 | `scout-squad` | Space Marines | Infiltration / Recon | 6 | 9 | SERGEANT | 4/4/4 | — | APRIL ’26 |
| 40 | `spectre-squad` | Astra Militarum | Infiltration / Recon | 12 | 11 | VETERAN SERGEANT | 4/4/4 | 1 | June 2026 |
| 41 | `tempestus-aquilons` | Astra Militarum | Seek & Destroy / Recon | 8 | 11 | TEMPESTOR | 4/4/4 | 2 | June 2026 |
| 42 | `vespid-stingwings` | T’au Empire | Seek & Destroy / Recon | 7 | 11 | STRAIN LEADER | 4/4/4 | 3 | November ’25 |
| 43 | `void-dancer-troupe` | Harlequins | Infiltration / Recon | 4 | 8 | LEAD PLAYER | 4/4/4 | 1 | October ’25 |
| 44 | `warpcoven` | Thousand Sons | Security / Recon | 10 | 5 | — | 4/4/4 | 3 | January ’26 |
| 45 | `wolf-scouts` | Space Marines | Seek & Destroy / Recon | 8 | 6 | PACK LEADER (in list) | 4/4/4 | 1 | APRIL ’26 |
| 46 | `wrecka-krew` | Orks | Seek & Destroy / Security | 7 | 8 | BOSS NOB | 4/4/4 | 5 | June 2026 |
| 47 | `wyrmblade` | Genestealer Cults | Seek & Destroy / Infiltration | 9 | 14 | NEOPHYTE LEADER | 4/4/4 | 1 | November ’25 |
| 48 | `xv26-stealth-battlesuits` | T’au Empire | Infiltration / Recon | 8 | 7 | SHAS’VRE | 4/4/4 | — | June 2026 |

### What the source did not give us

Every row is also in the team's `notes[]` and is printed by `validate.py`. Nothing was guessed.

| Team | Field the source did not give | What the data records |
| --- | --- | --- |
| `blades-of-khaine` | DIRE AVENGER EXARCH: option 'Shimmershield': ['Shimmershield'] is not a weapon on the datacard (kept verbatim in `items`) | `items[]` on the option |
| `exaction-squad` | R-VR Cyber-mastiff: unique action 'APPREHEND' has no AP cost on the page | see `notes[]` |
| `exodite-dragon-masters` | no datacard in this team carries the LEADER keyword — the leader is not marked on the source page | see `notes[]` |
| `gellerpox-infected` | selection entry 'MUTANT' has no datacard link on the page; matched by name to Mutant | see `notes[]` |
| `hunter-clade` | selection entry 'WARRIOR SICARIAN' has no datacard link on the page; matched by name to Sicarian Ruststalker Warrior | see `notes[]` |
| `pathfinders` | Medical Technician Pathfinder: unique action 'MEDIKIT' has no AP cost on the page | see `notes[]` |
| `pathfinders` | MV31 Pulse Accelerator Drone: unique action 'PULSE ACCELERATOR' has no AP cost on the page | see `notes[]` |
| `sanctifiers` | MISSIONARY: option 'Ministorum flamer; gun butt; holy relic': ['holy relic'] is not a weapon on the datacard (kept verbatim in `items`) | `items[]` on the option |
| `sanctifiers` | MISSIONARY: option 'Meltagun; chainsword; holy relic': ['holy relic'] is not a weapon on the datacard (kept verbatim in `items`) | `items[]` on the option |
| `warpcoven` | SORCERER DESTINY: footnote ^1 also grants ['force stave, PSYCHIC weapons on their datacard'] — not a named datacard weapon, left for the team module | see `notes[]` |
| `warpcoven` | SORCERER TEMPYRION: footnote ^1 also grants ['force stave, PSYCHIC weapons on their datacard'] — not a named datacard weapon, left for the team module | see `notes[]` |
| `warpcoven` | SORCERER WARPFIRE: footnote ^1 also grants ['force stave, PSYCHIC weapons on their datacard'] — not a named datacard weapon, left for the team module | see `notes[]` |
| `warpcoven` | no datacard in this team carries the LEADER keyword — the leader is not marked on the source page | see `notes[]` |
| `wolf-scouts` | Wolf Scout Frosteye: unique action 'HUNTER’S SENSES' text is truncated — the bullet list of selectable weapon rules the printed colon introduces is absent, and `notes[]` is empty (found while implementing batch 2, not flagged by `validate.py`) | nothing; the team module needs an explicit list |
| `wrecka-krew` | Breaka Boy Demolisha: weapon 'Tankhammer (detonate)' prints DMG '*' (resolved by a rule, not a number) — dmgN/dmgC recorded as 0 | see `notes[]` |
| `wrecka-krew` | Tankbusta Rokkiteer: weapon 'Pulsa rokkit' prints DMG '-' (resolved by a rule, not a number) — dmgN/dmgC recorded as 0 | see `notes[]` |

Reading those rows:

* **`APPREHEND` / `MEDIKIT` / `PULSE ACCELERATOR` have no AP cost** — Wahapedia prints
  `<span>AP</span>` with the number missing. `ap` records `0`; check the printed card before
  implementing them.
* **`exodite-dragon-masters` and `warpcoven` have no `LEADER` keyword** on any datacard. That is
  what the pages say — the string "LEADER" appears nowhere on either. Warpcoven's rule is
  "You must select at least one friendly SORCERER operative", surfaced as a `custom` constraint.
* **Two selection entries have no datacard link** (Gellerpox `MUTANT`; Hunter Clade
  `WARRIOR SICARIAN`, which the page wraps in a tooltip pointing at the wrong id). Both were
  matched by a **unique** name-word match against the still-unclaimed datacards, and the
  inference is recorded in `notes[]` — an ambiguous match would have been left unresolved.
* **Warpcoven footnote `^1`** grants "force stave, PSYCHIC weapons on their datacard" — not a
  single named weapon, so it is left to the team module. Those weapons are still reachable
  through `alwaysWeapons`.

---

## 7. Old `public/legacy/factions.js` vs the new data

legacy teams: 45 · new teams: 48
  base_notes_added: 6
  ops_added: 1
  ops_stale: 1
  stat_diffs: 7
  teams_compared: 45
  teams_missing: 3
  weapon_rule_diffs: 64
  weapon_rule_marker_only: 61
  weapon_stat_diffs: 12
  weapons_missing: 26
  weapons_stale: 22

`weapon_rule_marker_only` counts differences that are **only** a footnote marker
(`shield` vs `shield*`) — the same rule printed differently. Those are not listed below.

### Headline findings

1. **Three teams are missing from `factions.js` entirely** — `exodite-dragon-masters` (4
   datacards), `hearthkyn-salvager` (11) and `spectre-squad` (12).
2. **`Limited` lost its x everywhere.** The old file stores `"Limited"`; every printed form is
   `Limited 1`. Same class of bug for `Heavy`: 8 weapons print `Heavy (Reposition only)` where
   the old file has a bare `Heavy`.
3. **Distance-prefixed `Devastating` was flattened.** `1" Devastating 3` / `2" Devastating 1`
   were stored as plain `Devastating x`, losing the splash — Battleclade Eradication pistol,
   Lectro-Maester Voltaic pistol, Legionary Fireblast, Corsair Lightning strike, Sludge-Grub
   Acid spit and both Necron Tesla carbines.
4. **~20 rare weapon rules were dropped outright** — `Detonate`, `Phase Sweep`,
   `Dimensional Banishment`, `Drag`, `Prey`, `Stinger`, `Bipod`, `Explosive`, `Salvo`,
   `Siphon Life`, `Terrorchem`, `Poison`, `Toxic`, … Those weapons read as vanilla in the old app.
5. **Real stat errors**: Striking Scorpion Warrior SAVE 4→3, Canoptek Tomb Crawler W 21→18,
   MB3 Recon Drone APL 2→3, all three Rubric Marines SAVE 3→2, Wolf Scout Pack Leader W 14→13,
   the four Skitarii Alpha melee weapons HIT 3→4, six Ratling `(mobile)` sniper profiles HIT 4→3,
   and Arbites Marksman Executioner shotgun crit DMG 4→0 (its Devastating 4 supplies the damage).
6. **26 weapon profiles are missing from the old file** — including every Hierotek `(ranged)`
   psychic profile, both Navis shotgun profiles, both Bullgryn shields and the Sanctifier
   Cherub's Incentiviser — and **22 are stale**, including Angel of Death frag/krak grenades
   that no longer exist and a `VULGLAR THRICE-CURSED` typo for Vulgrar Thrice-Cursed.
7. **Six T'au drones are on flying bases** — new information the old file did not carry.

### Full comparison

### angel-of-death
- `Assault Intercessor Grenadier` weapons only in factions.js: ['Frag grenade', 'Krak grenade']
### battleclade
- `Battleclade Technoarcheologist` / Eradication pistol rules ['devastating 3', 'lethal 5+', 'range 8"'] (old) -> ['1" devastating 3', 'lethal 5+', 'range 8"']
- `Battleclade Breacher Servitor` weapons missing from factions.js: ['Lascutter (close range)']
### blades-of-khaine
- `Striking Scorpion Warrior` SAVE 4 (old) -> 3
### blooded
- `Traitor Brimstone Grenadier` / Diabolyk bomb rules ['blast 2"', 'devastating 2', 'heavy', 'limited', 'piercing 1', 'range 6"', 'saturate'] (old) -> ['blast 2"', 'devastating 2', 'heavy (reposition only)', 'limited 1', 'piercing 1', 'range 6"', 'saturate']
### brood-brother
- `Brood Brother Gunner` weapons missing from factions.js: ['Bayonet']
- `Brood Brother Medic` / Gene-needler rules ['lethal 5+', 'limited'] (old) -> ['lethal 5+', 'limited 1']
- `Brood Brother Sapper` / Demolition charge rules ['blast 2"', 'heavy', 'limited', 'piercing 1', 'range 3"', 'saturate'] (old) -> ['blast 2"', 'heavy (reposition only)', 'limited 1', 'piercing 1', 'range 3"', 'saturate']
### canoptek-circle
- `Canoptek Tomb Crawler` WOUNDS 21 (old) -> 18
- `Canoptek Tomb Crawler` / Transdimensional isolator rules [] (old) -> ['dimensional banishment']
### celestian-insidiants
- no differences
### chaos-cult
- no differences
### corsair-voidscarred
- `Voidscarred Way Seeker` / Lightning strike rules ['devastating 2', 'psychic'] (old) -> ['2" devastating 2', 'psychic']
### death-korps
- `Death Korps Sapper` / Remote detonator rules ['heavy (dash only)', 'limited', 'piercing 1', 'silent'] (old) -> ['detonate', 'heavy (dash only)', 'limited 1', 'piercing 1', 'silent']
### deathwatch
- `Deathwatch Blademaster Veteran` / Xenophase blade (phase sweep) rules ['brutal', 'lethal 5+'] (old) -> ['brutal', 'lethal 5+', 'phase sweep']
- `Deathwatch Breacher Veteran` / Melta bomb rules ['devastating 3', 'heavy', 'limited', 'piercing 2', 'range 3"'] (old) -> ['devastating 3', 'heavy (reposition only)', 'limited 1', 'piercing 2', 'range 3"']
### elucidian-starstrider
- `Lectro-Maester` / Voltaic pistol rules ['devastating 1', 'range 8"', 'rending'] (old) -> ['1" devastating 1', 'range 8"', 'rending']
### exaction-squad
- `Arbites Marksman` / Executioner shotgun (concealed) DMG(c) 4 (old) -> 0
- `Arbites Marksman` / Executioner shotgun (stationary) DMG(c) 4 (old) -> 0
- `Arbites Revelatum` weapons missing from factions.js: ['Scoped shotpistol (short range)', 'Scoped shotpistol (long range)']
- `Arbites Revelatum` weapons only in factions.js: ['Scoped shotpistol (short)', 'Scoped shotpistol (long)']
### exodite-dragon-masters
- **missing entirely from factions.js** (4 datacards on Wahapedia)
### farstalker-kinband
- `Kroot Heavy Gunner` / Dvorgite skinner rules ['heavy (reposition only)', 'piercing 2', 'torrent 2"'] (old) -> ['heavy (reposition only)', 'piercing 2', 'range 6"', 'torrent 2"']
- `Kroot Pistolier` / Dual Kroot pistols (salvo) rules ['range 8"'] (old) -> ['range 8"', 'salvo']
- `Kroot Tracker` weapons missing from factions.js: ['Blade']
- `Kroot Tracker` weapons only in factions.js: ["Stalker's blade"]
- `Kroot Warrior` weapons missing from factions.js: ['Blade']
- `Kroot Warrior` weapons only in factions.js: ["Stalker's blade"]
### fellgor-ravager
- no differences
### gellerpox-infected
- `Sludge-Grub` / Acid spit rules ['devastating 1', 'piercing 1', 'range 6"'] (old) -> ['1" devastating 1', 'piercing 1', 'range 6"']
- `Vulgrar Thrice-Cursed` — not in factions.js
- `Mutant` / Frag grenade rules ['blast 2"', 'limited', 'range 6"', 'saturate'] (old) -> ['blast 2"', 'limited 1', 'range 6"', 'saturate']
- `VULGLAR THRICE-CURSED` — in factions.js only (no such datacard)
### goremonger
- `Goremonger Impaler` / Fleshskewer (ranged) rules ['range 8"', 'stun'] (old) -> ['drag', 'prey', 'range 8"', 'stun']
### hand-of-the-archon
- `Kabalite Crimson Duellist` weapons only in factions.js: ['Array of blades']
- `Kabalite Disciple of Yaelindra` / Stinger pistol rules ['lethal 5+', 'range 8"'] (old) -> ['lethal 5+', 'range 8"', 'stinger']
### hearthkyn-salvager
- **missing entirely from factions.js** (11 datacards on Wahapedia)
### hernkyn-yaegir
- `Yaegir Bladekyn` / Throwing plasma knife rules ['lethal 5+', 'limited', 'range 6"', 'silent'] (old) -> ['lethal 5+', 'limited 1', 'range 6"', 'silent']
- `Yaegir Gunner` / APM launcher (armour piercing) rules ['heavy (reposition only)', 'piercing 1'] (old) -> ['bipod', 'heavy (reposition only)', 'piercing 1']
- `Yaegir Gunner` / APM launcher (breaching) rules ['blast 2"', 'heavy (reposition only)'] (old) -> ['bipod', 'blast 2"', 'heavy (reposition only)']
- `Yaegir Gunner` / APM launcher (high explosive) rules ['blast 3"', 'heavy (reposition only)'] (old) -> ['bipod', 'blast 3"', 'heavy (reposition only)']
- `Yaegir Tracker` / Throwing hatchet rules ['limited', 'range 6"', 'rending', 'silent'] (old) -> ['limited 1', 'range 6"', 'rending', 'silent']
### hierotek-circle
- `Chronomancer` weapons missing from factions.js: ['Aeonstave (ranged)', 'Entropic lance (ranged)']
- `Chronomancer` weapons only in factions.js: ['Aeonstave', 'Entropic lance']
- `Psychomancer` weapons missing from factions.js: ['Abyssal lance (ranged)']
- `Psychomancer` weapons only in factions.js: ['Abyssal lance']
- `Technomancer` weapons missing from factions.js: ['Staff of light (ranged)']
- `Technomancer` weapons only in factions.js: ['Staff of light']
- `Apprentek` weapons missing from factions.js: ['Arcane conduit (ranged)']
- `Apprentek` weapons only in factions.js: ['Arcane conduit']
- `Immortal Despotek` / Tesla carbine rules ['devastating 1'] (old) -> ['2" devastating 1']
- `Immortal Guardian` / Tesla carbine rules ['devastating 1'] (old) -> ['2" devastating 1']
### hunter-clade
- `Skitarii Ranger Alpha` / Power weapon HIT 3 (old) -> 4
- `Skitarii Ranger Alpha` / Taser goad HIT 3 (old) -> 4
- `Skitarii Vanguard Alpha` / Power weapon HIT 3 (old) -> 4
- `Skitarii Vanguard Alpha` / Taser goad HIT 3 (old) -> 4
### imperial-navy-breacher
- `Navis Sergeant-At-Arms` weapons missing from factions.js: ['Navis shotgun (close range)', 'Navis shotgun (long range)']
- `Navis Grenadier` / Demolition charge rules ['blast 2"', 'heavy', 'limited', 'piercing 1', 'range 3"', 'saturate'] (old) -> ['blast 2"', 'heavy (reposition only)', 'limited 1', 'piercing 1', 'range 3"', 'saturate']
- `Navis Void-Jammer` / Gheistskull detonator rules ['blast 1"', 'lethal 4+', 'limited', 'silent', 'stun'] (old) -> ['blast 1"', 'detonate', 'lethal 4+', 'limited 1', 'silent', 'stun']
### inquisitorial-agent
- no differences
### kasrkin
- no differences
### kommandos
- `Kommando Bomb Squig` / Explosives rules ['blast 1"', 'limited'] (old) -> ['blast 1"', 'explosive', 'limited 1']
- `Kommando Burna Boy` / Burna (deluge) rules ['range 4"', 'saturate', 'seek light', 'torrent 0"'] (old) -> ['range 4"', 'saturate', 'seek', 'torrent 0"']
### legionary
- `Legionary Balefire Acolyte` / Fireblast rules ['blast 2"', 'devastating 1', 'psychic', 'saturate'] (old) -> ['1" devastating 1', 'blast 2"', 'psychic', 'saturate']
- `Legionary Balefire Acolyte` / Life siphon rules ['psychic', 'saturate'] (old) -> ['psychic', 'saturate', 'siphon life']
### mandrakes
- no differences
### murderwing
- no differences
### nemesis-claw
- `Night Lord Fearmonger` / Terrorchem vial rules ['blast 2"', 'devastating 3', 'limited', 'range 6"', 'saturate'] (old) -> ['blast 2"', 'devastating 3', 'limited 1', 'range 6"', 'saturate', 'terrorchem']
### novitiates
- `Novitiate Superior` weapons missing from factions.js: ['Gun butt']
- `Novitiate Exactor` weapons missing from factions.js: ['Neural whips (melee)']
- `Novitiate Exactor` weapons only in factions.js: ['Neural whips']
- `Novitiate Militant` weapons missing from factions.js: ['Gun butt']
### pathfinders
- `Assault Grenadier Pathfinder` / Fusion grenade rules ['devastating 2', 'limited', 'piercing 2', 'range 6"', 'saturate'] (old) -> ['devastating 2', 'limited 1', 'piercing 2', 'range 6"', 'saturate']
- `MB3 Recon Drone` APL 2 (old) -> 3
### phobos-strike-team
- `Infiltrator Saboteur` / Remote detonator rules ['heavy (dash only)', 'limited', 'piercing 1', 'silent'] (old) -> ['detonate', 'heavy (dash only)', 'limited 1', 'piercing 1', 'silent']
- `Infiltrator Veteran` weapons missing from factions.js: ['Custom bolt carbine']
- `Infiltrator Veteran` weapons only in factions.js: ['Custom bolt carbine (Lethal 5+ / Piercing Crits 1)', 'Custom bolt carbine (Balanced / Rending)', 'Custom bolt carbine (Saturate / Lethal 5+)']
### plague-marines
- `Plague Marine Fighter` weapons missing from factions.js: ['Bolt pistol']
- `Plague Marine Heavy Gunner` weapons missing from factions.js: ['Bolt pistol']
- `Plague Marine Heavy Gunner` / Plague spewer rules ['range 7"', 'saturate', 'severe', 'torrent 2"'] (old) -> ['poison', 'range 7"', 'saturate', 'severe', 'torrent 2"']
- `Malignant Plaguecaster` / Entropy rules ['psychic', 'range 7"', 'saturate', 'severe'] (old) -> ['poison', 'psychic', 'range 7"', 'saturate', 'severe']
- `Malignant Plaguecaster` / Plague wind rules ['psychic', 'saturate', 'severe', 'torrent 1"'] (old) -> ['poison', 'psychic', 'saturate', 'severe', 'torrent 1"']
- `Plague Marine Warrior` / Boltgun rules [] (old) -> ['toxic']
### ratlings
- `Bullgryn` weapons missing from factions.js: ['Brute shield', 'Slabshield']
- `Bullgryn` weapons only in factions.js: ['Grenadier gauntlet']
- `Ratling Bomber` / Explosive arsenal rules ['blast 1"', 'heavy', 'limited', 'piercing 1', 'range 3"', 'saturate'] (old) -> ['blast 1"', 'heavy (reposition only)', 'limited 1', 'piercing 1', 'range 3"', 'saturate']
- `Ratling Bomber` / Sniper rifle (mobile) HIT 4 (old) -> 3
- `Ratling Raider` / Suppressed sniper rifle (mobile) HIT 4 (old) -> 3
- `Ratling Sneak` / Suppressed sniper rifle (mobile) HIT 4 (old) -> 3
- `Ratling Spotter` / Sniper rifle (mobile) HIT 4 (old) -> 3
- `Ratling Stashmaster` / Sniper rifle (mobile) HIT 4 (old) -> 3
- `Ratling Vox-Thief` / Sniper rifle (mobile) HIT 4 (old) -> 3
### raveners
- `Ravener Prime` / Tail blade rules ['rending', 'silent'] (old) -> ['range 3"', 'rending', 'silent']
- `Ravener Felltalon` / Pincer tail rules ['silent'] (old) -> ['range 3"', 'silent']
- `Ravener Felltalon` / Toxic glands rules ['range 6"', 'silent'] (old) -> ['poison', 'range 6"', 'silent']
- `Ravener Tremorscythe` / Pincer tail rules ['silent'] (old) -> ['range 3"', 'silent']
- `Ravener Venomspitter` / Pincer tail rules ['silent'] (old) -> ['range 3"', 'silent']
- `Ravener Venomspitter` / Venom bolt (blast) rules ['blast 2"', 'range 8"'] (old) -> ['blast 2"', 'poison', 'range 8"']
- `Ravener Venomspitter` / Venom bolt (focused) rules ['piercing 1', 'range 8"'] (old) -> ['piercing 1', 'poison', 'range 8"']
- `Ravener Warrior` / Pincer tail rules ['silent'] (old) -> ['range 3"', 'silent']
- `Ravener Wrecker` / Bone mace rules ['piercing 1', 'silent'] (old) -> ['piercing 1', 'range 3"', 'silent']
### sanctifiers
- `Sanctifier Cherub` weapons missing from factions.js: ['Incentiviser']
- `Sanctifier Conflagrator` / Twin hand flamers (twin torrent) rules ['blaze', 'range 6"', 'saturate', 'torrent 0"'] (old) -> ['blaze', 'range 6"', 'saturate', 'torrent 0"', 'twin torrent']
- `Sanctifier Miraculist` / Holy light rules ['blaze', 'devastating 3', 'limited', 'piercing 1', 'range 8"', 'saturate'] (old) -> ['blaze', 'devastating 3', 'limited 1', 'piercing 1', 'range 8"', 'saturate']
- `Sanctifier Miraculist` / Wreathe in fire rules ['blast 1"', 'blaze', 'limited'] (old) -> ['blast 1"', 'blaze', 'limited 1', 'wreathed']
- `Sanctifier Missionary` weapons missing from factions.js: ['Brazier of holy fire']
### scout-squad
- no differences
### spectre-squad
- **missing entirely from factions.js** (12 datacards on Wahapedia)
### tempestus-aquilons
- `Aquilon Grenadier` / Melta bomb rules ['devastating 3', 'heavy', 'limited', 'piercing 2', 'range 3"'] (old) -> ['devastating 3', 'heavy (reposition only)', 'limited 1', 'piercing 2', 'range 3"']
- `Aquilon Gunfighter` weapons missing from factions.js: ['Hot‑shot laspistols (point‑blank)']
- `Aquilon Gunfighter` weapons only in factions.js: ['Hot-shot laspistols (point-blank)']
- `Aquilon Gunfighter` / Hot‑shot laspistols (salvo) rules ['range 8"'] (old) -> ['range 8"', 'salvo']
### vespid-stingwings
- `Vespid Longsting` / Neutron rail rifle (standard) rules ['devastating 2'] (old) -> ['devastating 2', 'neutron fragment']
- `Vespid Longsting` / Neutron rail rifle (aimed) rules ['devastating 2', 'heavy (dash only)', 'lethal 5+'] (old) -> ['devastating 2', 'heavy (dash only)', 'lethal 5+', 'neutron fragment']
- `Vespid Shadestrain` / Neutron grenade rules ['blast 2"', 'devastating 2', 'limited', 'range 6"', 'saturate'] (old) -> ['blast 2"', 'devastating 2', 'limited 1', 'range 6"', 'saturate']
- `Vespid Skyblast` / Neutron grenade launcher rules ['blast 2"', 'devastating 2'] (old) -> ['blast 2"', 'devastating 2', 'neutron bombardment']
- `Vespid Swarmguard` / Flamer (skytorch) rules ['saturate', 'torrent 0"'] (old) -> ['saturate', 'skytorch', 'torrent 0"']
### void-dancer-troupe
- `Death Jester` / Shrieker cannon (focused) rules ['heavy (reposition only)', 'rending'] (old) -> ['heavy (reposition only)', 'humbling cruelty', 'rending']
- `Death Jester` / Shrieker cannon (sweeping) rules ['heavy (dash only)', 'rending', 'torrent 2"'] (old) -> ['heavy (dash only)', 'humbling cruelty', 'rending', 'torrent 2"']
### warpcoven
- `Sorcerer of Warpfire` / Mindburn rules ['lethal 5+', 'psychic', 'saturate', 'seek light'] (old) -> ['lethal 5+', 'mindburn', 'psychic', 'saturate', 'seek light']
- `Rubric Marine Gunner` SAVE 3 (old) -> 2
- `Rubric Marine Icon Bearer` SAVE 3 (old) -> 2
- `Rubric Marine Warrior` SAVE 3 (old) -> 2
### wolf-scouts
- `Wolf Scout Pack Leader` WOUNDS 14 (old) -> 13
- `Wolf Scout Frosteye` weapons missing from factions.js: ['Instigator bolt carbine']
- `Wolf Scout Frosteye` weapons only in factions.js: ['Instigator bolt carbine (heavy)', 'Instigator bolt carbine (mobile)']
- `Wolf Scout Rune Priest Skjald` weapons only in factions.js: ['Runic stave']
### wrecka-krew
- `Wrecka Boss Nob` / Two rokkit pistols (salvo) rules ['blast 1"', 'range 8"'] (old) -> ['blast 1"', 'range 8"', 'salvo']
- `Wrecka Bomb Squig` / Explosives rules ['blast 1"', 'limited'] (old) -> ['blast 1"', 'explosive', 'limited 1']
- `Tankbusta Rokkiteer` weapons missing from factions.js: ['Pulsa rokkit']
- `Tankbusta Rokkiteer` / Rokkit rack rules ['blast 2"', 'heavy (reposition only)', 'limited', 'relentless'] (old) -> ['blast 2"', 'heavy (reposition only)', 'limited 1', 'relentless']
### wyrmblade
- `Kelermorph` / Liberator autostubs (hypersense) rules ['range 6"', 'saturate', 'seek light'] (old) -> ['hypersense', 'range 6"', 'saturate', 'seek light']
### xv26-stealth-battlesuits
- `XV26 Shas’Vre` weapons only in factions.js: ['Fists']
- `XV26 Liberator` / EMP bomb rules ['blast 2"', 'devastating 1', 'heavy (reposition only)', 'lethal 4+', 'limited', 'range 4"', 'saturate'] (old) -> ['blast 2"', 'devastating 1', 'heavy (reposition only)', 'lethal 4+', 'limited 1', 'range 4"', 'saturate']
