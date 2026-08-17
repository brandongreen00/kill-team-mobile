#!/usr/bin/env python3
"""
Compare the OLD app's kill-team data (`public/legacy/factions.js`, vendored from
brandongreen00/ballistica-imperialis) with the new `data/teams/**`, and write
the coverage + discrepancy tables of docs/TEAM-DATA.md.

    python3 tools/teams/diff_report.py                 # print the report
    python3 tools/teams/diff_report.py --md out.md     # write markdown

Wahapedia is the source of truth: every difference below is read as "the old
file is wrong / stale", which the first-pass research
(docs/context-pack/research/kill-teams/compare_all.md) already established.

`factions.js` is JavaScript, so it is evaluated with node and dumped to JSON —
node is already a build dependency of this repo.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from selection import norm_weapon  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "data", "teams")
LEGACY = os.path.join(ROOT, "public", "legacy", "factions.js")

# `factions.js` slugs that differ from Wahapedia's (documented in the task brief)
SLUG_ALIASES = {"angels-of-death": "angel-of-death"}


def load_legacy() -> list[dict]:
    if not os.path.exists(LEGACY):
        return []
    src = "globalThis.window = undefined;\n" + open(LEGACY, encoding="utf-8").read() \
        + "\nprocess.stdout.write(JSON.stringify(FACTIONS));"
    # the file is ~350 KB, well past the `node -e` argv limit, so it goes to disk
    with tempfile.NamedTemporaryFile("w", suffix=".cjs", delete=False,
                                     encoding="utf-8") as fh:
        fh.write(src)
        path = fh.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True)
    except OSError as e:
        print(f"could not run node ({e}) — skipping the legacy comparison", file=sys.stderr)
        return []
    finally:
        os.unlink(path)
    if out.returncode != 0:
        print("could not evaluate factions.js:\n" + out.stderr, file=sys.stderr)
        return []
    return json.loads(out.stdout)


def load_new() -> dict[str, dict]:
    teams = {}
    for fn in sorted(os.listdir(DATA)):
        if fn.endswith(".json") and not fn.startswith("_"):
            with open(os.path.join(DATA, fn), encoding="utf-8") as f:
                t = json.load(f)
            teams[t["id"]] = t
    return teams


def _rule_key(raw: str) -> str:
    """Rule token normalised for comparison: footnote markers dropped, since
    `shield` and `shield*` are the same rule differently printed."""
    return re.sub(r"(\*+|\^\d+(?:,\d+)*)\s*$", "", raw.strip().lower()).strip()


def op_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def new_ops(team: dict) -> dict[str, dict]:
    """datacard -> flattened comparable shape."""
    out = {}
    for c in team["datacards"]:
        weps = {}
        for w in c["weapons"]:
            for p in w["profiles"]:
                nm = w["name"] + (f" ({p['name']})" if p.get("name") else "")
                weps[norm_weapon(nm) + ("|" + (p.get("name") or ""))] = {
                    "name": nm, "atk": p["atk"], "hit": p["hit"],
                    "dmgN": p["dmgN"], "dmgC": p["dmgC"],
                    "rules": [r["raw"] for r in p["rules"]],
                }
        out[op_key(c["name"])] = {
            "name": c["name"], "apl": c["apl"], "move": c["move"],
            "save": c["save"], "wounds": c["wounds"], "weapons": weps,
            "base": c["base"],
        }
    return out


def legacy_ops(f: dict) -> dict[str, dict]:
    out = {}
    for o in f.get("operatives", []):
        weps = {}
        for w in o.get("weapons", []):
            m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", w["name"])
            prof = m.group(2) if m else ""
            weps[norm_weapon(w["name"]) + "|" + prof] = {
                "name": w["name"], "atk": w.get("atk"), "hit": w.get("hit"),
                "dmgN": w.get("normal_dmg"), "dmgC": w.get("crit_dmg"),
                "rules": w.get("rules", []),
            }
        mv = o.get("move")
        mv = int(re.search(r"\d+", str(mv)).group(0)) if re.search(r"\d+", str(mv)) else None
        base = o.get("base") or {}
        out[op_key(o.get("full_name") or o.get("name", ""))] = {
            "name": o.get("full_name") or o.get("name"),
            "apl": o.get("apl"), "move": mv, "save": o.get("save"),
            "wounds": o.get("wounds"), "weapons": weps,
            "base": ({"shape": "round", "mm": base["d"]} if "d" in base
                     else {"shape": "oval", "mm": [base.get("w"), base.get("h")]} if base else None),
        }
    return out


def match_ops(new: dict, old: dict) -> list[tuple[str | None, str | None]]:
    """Pair operatives by normalised name, then by suffix/prefix containment
    (the old file drops the team prefix: 'GELLERPOX MUTANT' vs 'Mutant')."""
    pairs, used = [], set()
    for k in new:
        if k in old:
            pairs.append((k, k))
            used.add(k)
    for k in new:
        if any(p[0] == k for p in pairs):
            continue
        cands = [o for o in old if o not in used and (o.endswith(k) or k.endswith(o))]
        if len(cands) == 1:
            pairs.append((k, cands[0]))
            used.add(cands[0])
        else:
            pairs.append((k, None))
    for o in old:
        if o not in used:
            pairs.append((None, o))
    return pairs


def build_report() -> tuple[list[str], dict]:
    legacy = {SLUG_ALIASES.get(f["id"], f["id"]): f for f in load_legacy()}
    teams = load_new()
    lines: list[str] = []
    stats = defaultdict(int)
    per_team: dict[str, list[str]] = {}

    for slug in sorted(teams):
        t = teams[slug]
        rows: list[str] = []
        old = legacy.get(slug)
        if old is None:
            rows.append(f"**missing entirely from factions.js** "
                        f"({len(t['datacards'])} datacards on Wahapedia)")
            stats["teams_missing"] += 1
            per_team[slug] = rows
            continue
        n, o = new_ops(t), legacy_ops(old)
        if len(n) != len(o):
            rows.append(f"operative count {len(o)} (old) -> {len(n)} (Wahapedia)")
        for nk, ok in match_ops(n, o):
            if nk and not ok:
                rows.append(f"`{n[nk]['name']}` — not in factions.js")
                stats["ops_added"] += 1
                continue
            if ok and not nk:
                rows.append(f"`{o[ok]['name']}` — in factions.js only (no such datacard)")
                stats["ops_stale"] += 1
                continue
            a, b = n[nk], o[ok]
            for stat in ("apl", "move", "save", "wounds"):
                if b.get(stat) is not None and a[stat] != b[stat]:
                    rows.append(f"`{a['name']}` {stat.upper()} {b[stat]} (old) -> {a[stat]}")
                    stats["stat_diffs"] += 1
            if b.get("base") and a["base"] != b["base"]:
                rows.append(f"`{a['name']}` base {b['base']} (old) -> {a['base']}")
                stats["base_diffs"] += 1
            missing = [a["weapons"][k]["name"] for k in a["weapons"] if k not in b["weapons"]]
            extra = [b["weapons"][k]["name"] for k in b["weapons"] if k not in a["weapons"]]
            if missing:
                rows.append(f"`{a['name']}` weapons missing from factions.js: {missing}")
                stats["weapons_missing"] += len(missing)
            if extra:
                rows.append(f"`{a['name']}` weapons only in factions.js: {extra}")
                stats["weapons_stale"] += len(extra)
            for k in a["weapons"]:
                if k not in b["weapons"]:
                    continue
                wa, wb = a["weapons"][k], b["weapons"][k]
                for f_, lab in (("atk", "ATK"), ("hit", "HIT"), ("dmgN", "DMG(n)"), ("dmgC", "DMG(c)")):
                    if wb.get(f_) is not None and wa[f_] != wb[f_]:
                        rows.append(f"`{a['name']}` / {wa['name']} {lab} "
                                    f"{wb[f_]} (old) -> {wa[f_]}")
                        stats["weapon_stat_diffs"] += 1
                ra = {_rule_key(x) for x in wa["rules"]}
                rb = {_rule_key(x) for x in wb["rules"]}
                if ra != rb:
                    rows.append(f"`{a['name']}` / {wa['name']} rules "
                                f"{sorted(rb)} (old) -> {sorted(ra)}")
                    stats["weapon_rule_diffs"] += 1
                elif {x.strip().lower() for x in wa["rules"]} != \
                        {x.strip().lower() for x in wb["rules"]}:
                    # only the footnote marker differs (`shield` vs `shield*`)
                    stats["weapon_rule_marker_only"] += 1
        for key, label in (("strategyPloys", "strategy ploys"),
                           ("firefightPloys", "firefight ploys"),
                           ("equipment", "equipment")):
            oldkey = {"strategyPloys": "strategic_ploys",
                      "firefightPloys": "firefight_ploys",
                      "equipment": "equipment"}[key]
            no, oo = len(t[key]), len(old.get(oldkey, []))
            if no != oo:
                rows.append(f"{label}: {oo} (old) -> {no}")
        per_team[slug] = rows
        stats["teams_compared"] += 1

    for slug in sorted(legacy):
        if slug not in teams:
            per_team.setdefault(slug, []).append(
                "in factions.js but not on Wahapedia (removed / renamed team)")
            stats["teams_stale"] += 1

    lines.append(f"legacy teams: {len(legacy)} · new teams: {len(teams)}")
    for k in sorted(stats):
        lines.append(f"  {k}: {stats[k]}")
    return lines, per_team


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--md", default="", help="write a markdown fragment to this path")
    args = ap.parse_args()
    summary, per_team = build_report()
    print("\n".join(summary))
    body: list[str] = []
    for slug in sorted(per_team):
        rows = per_team[slug]
        body.append(f"### {slug}\n")
        body.append("- no differences\n" if not rows else
                    "".join(f"- {r}\n" for r in rows))
    if args.md:
        with open(args.md, "w", encoding="utf-8") as f:
            f.write("\n".join(summary) + "\n\n" + "".join(body))
        print(f"\nwrote {args.md}")
    else:
        print("\n" + "".join(body))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
