# `tools/teams` — the kill-team data pipeline

Build-time only. Turns the 48 Warhammer 40,000 Kill Team (3rd ed / KT24) team pages on
wahapedia.ru into the curated JSON in `data/teams/**` that `src/teams/*` consumes.
Nothing here ships in the app bundle, and the raw HTML is never committed
(see the IP note in `CLAUDE.md`).

## Run it

```bash
python3 tools/teams/scrape_wahapedia.py     # fetch + structure   -> .cache/wahapedia/
python3 tools/teams/normalise.py            # curate              -> data/teams/**
python3 tools/teams/validate.py             # lint                -> exit 1 on failure
python3 tools/teams/diff_report.py          # old factions.js vs new
```

or, from `package.json`:

```bash
pnpm teams:scrape && pnpm teams:normalise
```

Python 3.11+, standard library only. No third-party packages, no `pip install`.

### Useful flags

| Command | Flag | Effect |
| --- | --- | --- |
| `scrape_wahapedia.py` | `--refresh` | ignore cached HTML and refetch every page |
| | `--offline` | never touch the network (cache / checked-in snapshot / context-pack) |
| | `--only kasrkin,kommandos` | limit to some slugs |
| | `--delay 1.5` | politeness delay between network fetches (default 0.7s) |
| `normalise.py` | `--only <slugs>` | rebuild only those teams (the rare-rule registry then covers only those) |
| `validate.py` | `--json` | machine-readable `{errors, reports, counts}` |
| `diff_report.py` | `--md <path>` | write the comparison as a markdown fragment |

## Files

| File | Role |
| --- | --- |
| `scrape_wahapedia.py` | fetch + HTML → faithful raw JSON (one per team) |
| `wahapedia_html.py` | shared HTML→text helpers, base-size and granted-weapon-table parsing |
| `weapon_rules.py` | the weapon-rule token parser (23 universal rules + rare-rule ids) |
| `selection.py` | the `Operatives` section grammar (`<ul>` tree, loadouts, footnotes) |
| `constraints.py` | free-text selection constraints → structured `constraints[]` |
| `normalise.py` | raw → `data/teams/<slug>.json` + `_index.json` + `_rare-weapon-rules.json` |
| `validate.py` | data lint (fails CI on real problems, reports source gaps) |
| `diff_report.py` | `public/legacy/factions.js` vs the new data |

## How the scrape works

* **Team list.** `https://wahapedia.ru/kill-team3/kill-teams/` returns **403** to a plain
  client, so the canonical list is read from the nav dropdown embedded in *every* team page:
  `div.NavBtn_Factions + div.NavDropdown-content a[href^="/kill-team3/kill-teams/"]`.
  The same markup carries `div.FactionHeader` (grand faction) and `div.factionGroup_KT`
  (faction) — that is where each team's `faction` comes from.
* **UA.** `Mozilla/5.0` is required; the CDN 403s a default urllib UA. Fetches retry 4×
  with exponential backoff and a politeness delay.
* **Cache.** Pages land in `.cache/wahapedia/html/<slug>.html`, structured dumps in
  `.cache/wahapedia/raw/<slug>.json`, the derived team list in `.cache/wahapedia/index.json`.
  `.cache/` carries its own `.gitignore` so none of it is ever committed.
* **Degradation ladder** — the pipeline always produces output:
  1. network → `source: "network"`
  2. `.cache/wahapedia/html/` → `"cache"`
  3. `docs/context-pack/research/kill-teams/pages/<slug>.html` (checked-in snapshot) → `"seed"`
  4. `docs/context-pack/research/kill-teams/<slug>.json` (first-pass scrape) → `"context-pack"`,
     which also sets `degraded: true` and adds a team `note`, because that fallback has no
     tooltips, no Books table and no keyword links.

### Selectors captured

| What | Selector |
| --- | --- |
| Books / version | `a[name=Books]` + the following `<table>`; the `Faction` row's Version cell (falling back to Last update, which several pages print instead) |
| Archetypes | `div.archetype > a` |
| Selection | `a[name=Operatives]` → `ul.redTriangle` groups + trailing free text |
| Faction rules | `a[name=Faction-Rules]` → `a[name=…] + h3` blocks, `p.ShowFluff.legend2` split out |
| Ploys / equipment | `a[name=Strategy-Ploys]` … `a[name=Datacards]`, `div.stratName.strat{StrategicPloy,TacticalPloy,Equipment}` |
| Datacards | `a[name=…] + div.pagebreak > div.dsOuterFrame` |
| Stats | `td.pCell` → `APL / MOVE / SAVE / WOUNDS` |
| Weapons | `tbody.bkg > tr` with `td.wTable2_short.wsData{Ranged,Melee}`, WR from `span.wTable1_short` |
| Abilities | `span.redfont` + `<b>Name:</b>` forms; footnote notes (`*Note that Torrent 0" …`) kept separately |
| Unique actions | `h3.h_actions_ds` + `div.actionEffect` / `div.actionConditions` |
| Keywords | `span.dsKeywordData` |
| Base size | `td.ShowBaseSize` — `⌀25mm`, `⌀60x35mm`, `⌀32mm flying base` |
| Glossary | `div.tooltip_templates > span[id^=tooltip_content]` (rare weapon rules, keywords) |

Footnote markers are preserved through text extraction: `span.ast` stays a literal `*`, and
`<sup>1</sup>` becomes `^1` so it survives whitespace folding. That is what links a weapon's
`Poison*` to the datacard ability that defines it.

## Contract & decisions

The per-team JSON contract, the selection grammar, every unresolved source value and every
`custom` constraint that still needs a team-module hook are documented in
**`docs/TEAM-DATA.md`**. Read that before writing a `src/teams/<slug>/index.ts`.
