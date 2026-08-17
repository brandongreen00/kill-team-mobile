#!/usr/bin/env python3
"""
Lint `data/teams/**` against the contract in docs/TEAM-DATA.md and the types in
src/core/types.ts.

    python3 tools/teams/validate.py            # human report, exit 1 on failure
    python3 tools/teams/validate.py --json     # machine-readable

FAILS (exit 1) on:
  * a weapon-rule id that is neither one of the 23 universal rules nor present
    in data/teams/_rare-weapon-rules.json
  * a datacard with no base size
  * a datacard missing APL / Move / Save / Wounds
  * a weapon profile with no Atk or Hit, or with no profiles at all
  * a duplicate id anywhere, or a selection entry pointing at a datacard that
    does not exist
  * a malformed BaseShape / WeaponRule / Datacard field

REPORTS (does not fail) — some teams legitimately differ, so these are listed
rather than enforced:
  * a team with != 4 strategy ploys, != 4 firefight ploys or != 4 equipment
  * every `notes[]` entry a team carries (unresolved source values)
  * every `{"kind":"custom"}` selection constraint (needs a team-module hook)
  * rare weapon rules with no printed definition
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from weapon_rules import UNIVERSAL  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, "data", "teams")

EXPECTED = {"strategyPloys": 4, "firefightPloys": 4, "equipment": 4}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    errors: list[str] = []
    reports: list[str] = []

    rare_path = os.path.join(DATA, "_rare-weapon-rules.json")
    if not os.path.exists(rare_path):
        print("FATAL: data/teams/_rare-weapon-rules.json missing — run normalise.py",
              file=sys.stderr)
        return 2
    with open(rare_path, encoding="utf-8") as f:
        rare_doc = json.load(f)
    rare = {r["id"]: r for r in rare_doc["rules"]}

    files = sorted(fn for fn in os.listdir(DATA)
                   if fn.endswith(".json") and not fn.startswith("_"))
    all_ids: dict[str, str] = {}
    counts = {"teams": 0, "datacards": 0, "weapons": 0, "profiles": 0, "rules": 0}

    def uid(scope: str, i: str) -> None:
        if i in all_ids:
            errors.append(f"duplicate id {i!r} ({scope} and {all_ids[i]})")
        all_ids[i] = scope

    for fn in files:
        slug = fn[:-5]
        with open(os.path.join(DATA, fn), encoding="utf-8") as f:
            t = json.load(f)
        counts["teams"] += 1
        if t.get("id") != slug:
            errors.append(f"{slug}: id field {t.get('id')!r} != filename")
        for field in ("name", "faction", "archetypes", "sourceUrl", "selection",
                      "datacards", "factionRules", "strategyPloys",
                      "firefightPloys", "equipment"):
            if field not in t:
                errors.append(f"{slug}: missing top-level field {field!r}")
        if not t.get("booksVersion"):
            reports.append(f"{slug}: no Books version string on the page")
        if not t.get("archetypes"):
            reports.append(f"{slug}: no archetypes")

        for key, want in EXPECTED.items():
            n = len(t.get(key, []))
            if n != want:
                reports.append(f"{slug}: {n} {key} (expected {want})")

        card_ids: set[str] = set()
        for c in t.get("datacards", []):
            counts["datacards"] += 1
            cid = c.get("id", "")
            card_ids.add(cid)
            uid(f"{slug} datacard", cid)
            where = f"{slug}/{c.get('name', cid)}"
            b = c.get("base")
            if not isinstance(b, dict) or b.get("shape") not in ("round", "oval"):
                errors.append(f"{where}: malformed base {b!r}")
            elif b["shape"] == "round" and not isinstance(b.get("mm"), int):
                errors.append(f"{where}: round base without mm")
            elif b["shape"] == "round" and b["mm"] <= 0:
                errors.append(f"{where}: no base size")
            elif b["shape"] == "oval" and (not isinstance(b.get("mm"), list)
                                           or len(b["mm"]) != 2 or min(b["mm"]) <= 0):
                errors.append(f"{where}: malformed oval base {b.get('mm')!r}")
            for stat in ("apl", "save", "wounds"):
                v = c.get(stat)
                if not isinstance(v, int) or v <= 0:
                    errors.append(f"{where}: {stat} missing or non-positive ({v!r})")
            mv = c.get("move")
            if not isinstance(mv, int) or mv < 0:
                errors.append(f"{where}: move missing ({mv!r})")
            elif mv == 0:
                reports.append(f"{where}: Move 0 on the source page (static operative)")
            if not c.get("keywords"):
                errors.append(f"{where}: no keywords")
            for w in c.get("weapons", []):
                counts["weapons"] += 1
                if not w.get("name"):
                    errors.append(f"{where}: weapon with no name")
                if not w.get("profiles"):
                    errors.append(f"{where}: weapon {w.get('name')!r} has no profiles")
                for p in w.get("profiles", []):
                    counts["profiles"] += 1
                    tag = f"{where}/{w.get('name')}" + (f" ({p['name']})" if p.get("name") else "")
                    if p.get("type") not in ("ranged", "melee"):
                        errors.append(f"{tag}: bad weapon type {p.get('type')!r}")
                    if not isinstance(p.get("atk"), int) or p["atk"] <= 0:
                        errors.append(f"{tag}: bad Atk {p.get('atk')!r}")
                    if not isinstance(p.get("hit"), int) or not 2 <= p["hit"] <= 6:
                        errors.append(f"{tag}: bad Hit {p.get('hit')!r}")
                    for r in p.get("rules", []):
                        counts["rules"] += 1
                        rid = r.get("id")
                        if not r.get("raw"):
                            errors.append(f"{tag}: rule {rid!r} has no verbatim `raw`")
                        if rid in UNIVERSAL:
                            if UNIVERSAL[rid] and "x" not in r and rid != "Heavy":
                                reports.append(f"{tag}: {rid} printed without its x ({r.get('raw')!r})")
                        elif rid not in rare:
                            errors.append(f"{tag}: weapon rule {rid!r} "
                                          f"({r.get('raw')!r}) is neither universal nor in "
                                          f"_rare-weapon-rules.json")
            for a in c.get("abilities", []):
                uid(f"{slug} ability", a["id"])
                if not a.get("text"):
                    errors.append(f"{where}: ability {a.get('name')!r} has no text")
            for a in c.get("uniqueActions", []):
                uid(f"{slug} action", a["id"])
                if not isinstance(a.get("ap"), int):
                    errors.append(f"{where}: action {a.get('name')!r} has no AP")

        sel = t.get("selection", {})
        for e in sel.get("list", []) + sel.get("leaderList", []):
            if e.get("datacardId") and e["datacardId"] not in card_ids:
                errors.append(f"{slug}: selection entry {e.get('role')!r} points at "
                              f"unknown datacard {e['datacardId']!r}")
            if not e.get("datacardId"):
                reports.append(f"{slug}: selection entry {e.get('role')!r} is not linked "
                               f"to a datacard")
        if sel.get("slots", 0) <= 0:
            errors.append(f"{slug}: selection.slots is {sel.get('slots')!r}")
        for c in sel.get("constraints", []):
            if c.get("kind") == "custom":
                reports.append(f"{slug}: custom constraint needs a team-module hook "
                               f"[{c.get('hook')}] {c.get('text')!r}")

        for key in ("factionRules", "strategyPloys", "firefightPloys", "equipment"):
            for b in t.get(key, []):
                uid(f"{slug} {key}", b["id"])
                if not b.get("text"):
                    errors.append(f"{slug}: {key} {b.get('name')!r} has no text")
        for n in t.get("notes", []):
            reports.append(f"{slug}: {n}")

    for rid, r in sorted(rare.items()):
        if r.get("unresolved"):
            reports.append(f"rare rule {rid!r} has no printed definition "
                           f"(used by {', '.join(r['teams'])})")

    if args.json:
        print(json.dumps({"errors": errors, "reports": reports, "counts": counts},
                         indent=1, ensure_ascii=False))
        return 1 if errors else 0

    print(f"teams {counts['teams']} · datacards {counts['datacards']} · "
          f"weapons {counts['weapons']} · profiles {counts['profiles']} · "
          f"weapon rules {counts['rules']}")
    print(f"\n{len(reports)} report(s) — informational, not failures:")
    for r in reports:
        print("  ·", r)
    if errors:
        print(f"\n{len(errors)} ERROR(s):")
        for e in errors:
            print("  ✗", e)
        return 1
    print("\nno errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
