#!/usr/bin/env python3
"""
Turn the raw Wahapedia dumps in `.cache/wahapedia/raw/` into the curated,
type-checked team data the app consumes.

    python3 tools/teams/scrape_wahapedia.py     # first
    python3 tools/teams/normalise.py            # then

Output
  data/teams/<slug>.json             one file per kill team (48)
  data/teams/_index.json             slug -> name / faction / archetypes / counts
  data/teams/_rare-weapon-rules.json every non-universal weapon-rule token,
                                     with the teams that use it and the verbatim
                                     definition text (never silently dropped)

Everything deserialises into src/core/types.ts: `datacards[]` is `Datacard[]`,
`weapons[].profiles[]` is `WeaponProfile[]`, `rules[]` is `WeaponRule[]`,
`base` is `BaseShape`. The `selection`, `factionRules`, `strategyPloys`,
`firefightPloys` and `equipment` blocks are team-module inputs and are described
in docs/TEAM-DATA.md.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from constraints import parse_constraints  # noqa: E402
from selection import (  # noqa: E402
    RE_EVERY,
    parse_footnote_blocks,
    RE_SAME_AS_ABOVE,
    norm_weapon,
    own_html,
    parse_entry,
    parse_top_list,
    slugify,
    strip_marker,
)
from wahapedia_html import parse_base  # noqa: E402
from weapon_rules import UNIVERSAL, parse_wr, public_rule  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW_DIR = os.path.join(ROOT, ".cache", "wahapedia", "raw")
OUT_DIR = os.path.join(ROOT, "data", "teams")

PROFILE_RE = re.compile(r"^(.*?)\s*\(([^()]*)\)\s*$")
AP_RE = re.compile(r"(\d+)\s*AP", re.I)


# ==========================================================================
# datacards
# ==========================================================================


def card_local_id(team_name: str, card_name: str) -> str:
    """'Kasrkin Sergeant' in team 'Kasrkin' -> 'sergeant'."""
    tw = [w for w in re.split(r"\W+", team_name.lower()) if w]
    cw = [w for w in re.split(r"\W+", card_name) if w]
    i = 0
    while i < len(cw) and i < len(tw) and cw[i].lower() == tw[i]:
        i += 1
    rest = cw[i:] or cw
    return slugify(" ".join(rest))


def parse_stat(raw: str, kind: str) -> int | None:
    if raw is None:
        return None
    m = re.search(r"(\d+)", raw)
    return int(m.group(1)) if m else None


def build_weapons(rows: list[dict], team_id: str, card_name: str,
                  rare_sink: dict, notes: list[str]) -> list[Weapon]:  # noqa: F821
    """Group `Name (profile)` rows into one Weapon with several profiles.
    Row order is preserved; the first row for a base name fixes its position."""
    order: list[str] = []
    groups: dict[str, dict] = {}
    for r in rows:
        m = PROFILE_RE.match(r["name"])
        base = (m.group(1) if m else r["name"]).strip()
        pname = m.group(2).strip() if m else ""
        key = norm_weapon(base)
        if key not in groups:
            order.append(key)
            groups[key] = {"name": base, "profiles": []}
        dmg = r["dmg"].strip()
        dm = re.match(r"^(\d+)\s*/\s*(\d+)$", dmg)
        if dm:
            dmg_n, dmg_c = int(dm.group(1)), int(dm.group(2))
        else:
            dmg_n = dmg_c = 0
            notes.append(
                f"{card_name}: weapon '{r['name']}' prints DMG '{dmg}' "
                f"(resolved by a rule, not a number) — dmgN/dmgC recorded as 0")
        rules_raw = parse_wr(r["wr"])
        rules = []
        for rr in rules_raw:
            if rr["rare"]:
                rare_sink.setdefault(rr["id"], {
                    "id": rr["id"], "name": rr["name"], "teams": set(),
                    "usedBy": [], "raw": set(), "definition": "", "definedIn": "",
                })
                s = rare_sink[rr["id"]]
                s["teams"].add(team_id)
                s["raw"].add(rr["raw"])
                s["usedBy"].append(f"{team_id}:{card_name}:{r['name']}")
            rules.append(public_rule(rr))
        groups[key]["profiles"].append({
            **({"name": pname} if pname else {}),
            "type": r["type"],
            "atk": parse_stat(r["atk"], "atk") or 0,
            "hit": parse_stat(r["hit"], "hit") or 0,
            "dmgN": dmg_n,
            "dmgC": dmg_c,
            "rules": rules,
        })
    return [groups[k] for k in order]


def build_datacard(team: dict, raw_card: dict, rare_sink: dict,
                   notes: list[str]) -> dict:
    team_id = team["slug"]
    local = card_local_id(team["name"], raw_card["name"])
    cid = f"{team_id}.{local}"
    base = parse_base(raw_card.get("baseRaw", ""))
    if base is None:
        notes.append(f"{raw_card['name']}: no base size on the page (td.ShowBaseSize empty)")
    stats = raw_card.get("stats", {})
    for k in ("APL", "MOVE", "SAVE", "WOUNDS"):
        if parse_stat(stats.get(k), k) is None:
            notes.append(f"{raw_card['name']}: missing {k} stat on the page")

    abilities = []
    used: set[str] = set()
    for a in raw_card.get("abilities", []):
        aid = f"{cid}.{slugify(a['name'])}"
        while aid in used:
            aid += "x"
        used.add(aid)
        abilities.append({"id": aid, "name": a["name"], "text": a["text"]})

    actions = []
    for a in raw_card.get("actions", []):
        name, _mk = strip_marker(a["name"])
        aid = f"{cid}.act.{slugify(name)}"
        while aid in used:
            aid += "x"
        used.add(aid)
        ap_m = AP_RE.search(a.get("cost", ""))
        if not ap_m:
            notes.append(f"{raw_card['name']}: unique action '{name}' has no AP cost on the page")
        body = "\n\n".join([t for t in a.get("effect", []) if t]
                           + [t for t in a.get("conditions", []) if t]) or a.get("text", "")
        entry = {"id": aid, "name": name, "ap": int(ap_m.group(1)) if ap_m else 0, "text": body}
        if a.get("keywords"):
            entry["keywords"] = a["keywords"]
        actions.append(entry)

    card = {
        "id": cid,
        "teamId": team_id,
        "name": raw_card["name"],
        "keywords": raw_card.get("keywords", []),
        "base": base or {"shape": "round", "mm": 0},
        "apl": parse_stat(stats.get("APL"), "APL") or 0,
        "move": parse_stat(stats.get("MOVE"), "MOVE") or 0,
        "save": parse_stat(stats.get("SAVE"), "SAVE") or 0,
        "wounds": parse_stat(stats.get("WOUNDS"), "WOUNDS") or 0,
        "weapons": build_weapons(raw_card.get("weapons", []), team_id,
                                 raw_card["name"], rare_sink, notes),
        "abilities": abilities,
        "uniqueActions": actions,
    }
    if raw_card.get("fluff"):
        card["fluff"] = raw_card["fluff"]
    if raw_card.get("footnotes"):
        card["footnotes"] = raw_card["footnotes"]
    return card


# ==========================================================================
# rules / ploys / equipment
# ==========================================================================


def granted_weapons(block: dict, team_id: str, ctx: str,
                    rare_sink: dict, notes: list[str]) -> list[dict]:
    rows = block.get("grantedWeapons") or []
    if not rows:
        return []
    return build_weapons(rows, team_id, ctx, rare_sink, notes)


def build_blocks(raw_blocks: list[dict], team_id: str, kind: str,
                 rare_sink: dict, notes: list[str], cp: int | None = None) -> list[dict]:
    out = []
    for b in raw_blocks:
        bid = f"{team_id}.{kind}.{slugify(b['name'])}"
        entry: dict = {"id": bid, "name": b["name"], "text": b.get("text", "")}
        if cp is not None:
            entry["cp"] = cp
        if b.get("fluff"):
            entry["fluff"] = b["fluff"]
        w = granted_weapons(b, team_id, f"{kind}:{b['name']}", rare_sink, notes)
        if w:
            entry["weapons"] = w
        out.append(entry)
    return out


# ==========================================================================
# selection
# ==========================================================================


def build_selection(raw: dict, cards: list[dict], anchor_to_card: dict[str, str],
                    notes: list[str]) -> dict:
    slug = raw["slug"]
    items, free_html = parse_top_list(raw["selection"]["html"])

    known: dict[str, str] = {}
    for c in cards:
        for w in c["weapons"]:
            known.setdefault(norm_weapon(w["name"]), w["name"])
    role_anchor: dict[str, str] = {}

    groups: list[dict] = []
    entries: list[dict] = []
    for gi, item in enumerate(items, 1):
        head = parse_entry(item, known, f"{slug}.g{gi}")
        nested = head.pop("_nested", None)
        if nested is None:
            if not head["role"] and RE_SAME_AS_ABOVE.search(head["rawText"]):
                # "5 X operatives selected from the list above, or ..."
                groups.append({"index": gi, "count": head["count"], "kind": "sameAsAbove",
                               "roles": [], "rawText": head["rawText"]})
                continue
            head["group"] = gi
            entries.append(head)
            groups.append({"index": gi, "count": head["count"], "kind": "fixed",
                           "roles": [head["role"]], "rawText": head["rawText"]})
            if head["role"] and head["datacardAnchor"]:
                role_anchor.setdefault(head["role"], head["datacardAnchor"])
            continue
        members: list[str] = []
        prev: dict | None = None
        for ei, sub in enumerate(nested, 1):
            e = parse_entry(sub, known, f"{slug}.g{gi}e{ei}")
            e.pop("_nested", None)
            e["group"] = gi
            # "Or the following option:" is printed as its own role-less <li>;
            # it is an alternative loadout for the entry above it.
            if not e["role"] and prev is not None and re.match(r"(?i)^\s*or\b", e["rawText"]):
                prev["loadouts"].extend(e["loadouts"])
                prev["optionGroups"].extend(e["optionGroups"])
                prev["loadoutMode"] = "either"
                prev["rawText"] = (prev["rawText"] + " " + e["rawText"]).strip()
                continue
            if not e["role"]:
                notes.append(f"selection entry with no role in group {gi}: {e['rawText']!r}")
            entries.append(e)
            members.append(e["role"])
            prev = e
            if e["role"] and e["datacardAnchor"]:
                role_anchor.setdefault(e["role"], e["datacardAnchor"])
        every = bool(RE_EVERY.match(head["rawText"]))
        gcount = (sum(e["count"] for e in entries if e["group"] == gi)
                  if every else head["count"])
        groups.append({"index": gi, "count": gcount,
                       "kind": "every" if every else "list",
                       "roles": members, "rawText": head["rawText"]})

    # repeated role entries ("GUNNER with meltagun") carry no link — inherit it
    for e in entries:
        if not e["datacardAnchor"] and e["role"] in role_anchor:
            e["datacardAnchor"] = role_anchor[e["role"]]
        e["datacardId"] = anchor_to_card.get(e["datacardAnchor"], "")
    linked = {e["datacardId"] for e in entries if e["datacardId"]}
    by_role_fallback: dict[str, str] = {}
    for e in entries:
        if e["datacardId"] or not e["role"]:
            continue
        if e["role"] in by_role_fallback:
            e["datacardId"] = by_role_fallback[e["role"]]
            continue
        # Wahapedia sometimes prints a role without its datacard link
        # (Gellerpox MUTANT, Hunter Clade WARRIOR SICARIAN). Fall back to a
        # UNIQUE word-set match against the still-unclaimed datacards; ambiguity
        # is reported, never guessed.
        want = set(re.split(r"\W+", e["role"].lower())) - {""}
        cands = [c for c in cards
                 if c["id"] not in linked
                 and want <= set(re.split(r"\W+", c["name"].lower()))]
        if len(cands) == 1:
            e["datacardId"] = cands[0]["id"]
            by_role_fallback[e["role"]] = cands[0]["id"]
            linked.add(cands[0]["id"])
            notes.append(f"selection entry '{e['role']}' has no datacard link on the page; "
                         f"matched by name to {cands[0]['name']}")
        else:
            notes.append(f"selection entry '{e['role']}' could not be linked to a datacard "
                         f"(anchor {e['datacardAnchor'] or 'none'}, "
                         f"{len(cands)} name candidates)")

    cards_by_id = {c["id"]: c for c in cards}
    # Every datacard weapon NOT named in any selection option of that datacard is
    # always available (e.g. the Navis Grenadier keeps its demolition charge and
    # both Navis shotgun profiles). Named-ness is pooled per DATACARD, because a
    # role can appear as several entries with different fixed weapons.
    for e in entries:
        c = cards_by_id.get(e["datacardId"])
        e["isLeader"] = bool(c and "LEADER" in c["keywords"])

    from wahapedia_html import text_of as _text_of
    constraints, footnotes = parse_constraints(_text_of(free_html), slug)
    fn_blocks = parse_footnote_blocks(free_html, known, slug)
    for marker, blk in fn_blocks.items():
        if blk["text"] and marker not in footnotes:
            footnotes[marker] = blk["text"]

    fn_texts = {b["text"] for b in fn_blocks.values() if b["loadouts"] and b["text"]}
    constraints = [c for c in constraints
                   if not (c["kind"] == "custom" and any(c["text"] in t or t in c["text"]
                                                         for t in fn_texts))]

    unique_except = next((c for c in constraints if c["kind"] == "uniqueExcept"), None)
    for e in entries:
        if unique_except is not None:
            e["uniqueUnlessRole"] = e["role"] not in unique_except["roles"]
        for c in constraints:
            if c["kind"] == "requires" and c["role"] == e["role"]:
                e["requires"].append(c["requiresRole"])
        if e["footnoteGroup"]:
            for c in constraints:
                if c["kind"] == "halfSelection" and c["group"] == e["footnoteGroup"]:
                    e["selectionCost"] = 0.5
                if c["kind"] == "selectionCost" and c["group"] == e["footnoteGroup"]:
                    e["selectionCost"] = float(c["cost"])
            blk = fn_blocks.get(e["footnoteGroup"])
            if blk and blk.get("fixedWeapons") and not e["fixedWeapons"]:
                e["fixedWeapons"] = list(blk["fixedWeapons"])
            if blk and blk["loadouts"] and not e["loadouts"] and not e["optionGroups"]:
                # "*With one of the following options: ..." printed once for
                # every role carrying that marker (Hearthkyn Salvager, Warpcoven)
                e["loadouts"] = [dict(o) for o in blk["loadouts"]]
                e["loadoutMode"] = "choice"
                e["loadoutFromFootnote"] = e["footnoteGroup"]
                if blk.get("unresolvedFixed"):
                    notes.append(f"{e['role']}: footnote {e['footnoteGroup']} also grants "
                                 f"{blk['unresolvedFixed']} — not a named datacard weapon, "
                                 f"left for the team module")

    # Every datacard weapon NOT named in any selection option of that datacard is
    # always available (e.g. the Navis Grenadier keeps its demolition charge and
    # both Navis shotgun profiles). Named-ness is pooled per DATACARD, because a
    # role can appear as several entries with different fixed weapons. Computed
    # last, so footnote-defined loadouts are already in place.
    named_by_card: dict[str, set[str]] = {}
    for e in entries:
        acc = named_by_card.setdefault(e["datacardId"], set())
        acc |= {norm_weapon(w) for w in e["fixedWeapons"]}
        for o in e["loadouts"]:
            acc |= {norm_weapon(w) for w in o["weapons"]}
        for g in e["optionGroups"]:
            for o in g["choices"]:
                acc |= {norm_weapon(w) for w in o["weapons"]}
    for e in entries:
        c = cards_by_id.get(e["datacardId"])
        if c:
            named = named_by_card.get(e["datacardId"], set())
            e["alwaysWeapons"] = [w["name"] for w in c["weapons"]
                                  if norm_weapon(w["name"]) not in named]
        else:
            e["alwaysWeapons"] = []
        if float(e["selectionCost"]).is_integer():
            e["selectionCost"] = int(e["selectionCost"])

    # A "dedicated" group is one whose every member is a LEADER — that is the
    # team's leader slot. When no such group exists the leader is picked from a
    # mixed list (Deathwatch, Wolf Scouts) and consumes an ordinary slot.
    leaders = [e for e in entries if e["isLeader"]]
    by_group: dict[int, list[dict]] = {}
    for e in entries:
        by_group.setdefault(e["group"], []).append(e)
    dedicated = [g["index"] for g in groups
                 if g["kind"] == "list" or g["kind"] == "fixed"
                 if by_group.get(g["index"]) and all(e["isLeader"] for e in by_group[g["index"]])]
    ded_leaders = [e for e in leaders if e["group"] in dedicated]

    total = sum(g["count"] for g in groups)
    if ded_leaders:
        in_list = False
        slots = total - sum(g["count"] for g in groups if g["index"] in dedicated)
        pool = ded_leaders
    else:
        in_list = bool(leaders)
        slots = total
        pool = leaders

    if len(pool) == 1:
        le = pool[0]
        leader_block = {"role": le["role"], "datacardId": le["datacardId"],
                        "count": le["count"], "loadouts": le["loadouts"],
                        "optionGroups": le["optionGroups"],
                        "loadoutMode": le["loadoutMode"],
                        "fixedWeapons": le["fixedWeapons"],
                        "alwaysWeapons": le.get("alwaysWeapons", []),
                        "choices": [le["role"]], "inList": in_list}
    elif pool:
        leader_block = {"role": None, "datacardId": None,
                        "count": next((g["count"] for g in groups
                                       if g["index"] in dedicated), 1) if dedicated else 1,
                        "loadouts": [], "optionGroups": [], "loadoutMode": "choice",
                        "fixedWeapons": [], "alwaysWeapons": [],
                        "choices": [e["role"] for e in pool], "inList": in_list}
    else:
        leader_block = {"role": None, "datacardId": None, "count": 0, "loadouts": [],
                        "optionGroups": [], "loadoutMode": "fixed",
                        "fixedWeapons": [], "alwaysWeapons": [], "choices": [],
                        "inList": False}
        notes.append("no datacard in this team carries the LEADER keyword — the "
                     "leader is not marked on the source page")

    ded_ids = {id(e) for e in ded_leaders}
    return {
        "leader": leader_block,
        "slots": slots,
        "totalOperatives": total,
        "groups": groups,
        "list": [e for e in entries if id(e) not in ded_ids],
        "leaderList": [e for e in entries if e["isLeader"]],
        "constraints": constraints,
        "footnotes": footnotes,
        "footnoteOptions": fn_blocks,
        "designerNotes": raw["selection"].get("designerNotes", []),
        "rawText": raw["selection"]["text"],
    }


# ==========================================================================
# rare weapon rules
# ==========================================================================


def resolve_rare(rare_sink: dict, teams: dict[str, dict], raws: dict[str, dict]) -> dict:
    """Attach the verbatim definition for every rare rule.

    Definitions live, in order of preference, in: a datacard ability of the same
    name (the `*Shield` / `^1Twin Torrent` footnote form), a faction rule of the
    same name, or the page's tooltip glossary."""
    out: dict[str, dict] = {}
    for rid, s in sorted(rare_sink.items()):
        definition, defined_in = "", ""
        for team_id in sorted(s["teams"]):
            raw = raws[team_id]
            for c in raw["datacards"]:
                for a in c.get("abilities", []):
                    if a["name"].strip().lower() == s["name"].strip().lower():
                        definition, defined_in = a["text"], f"{team_id}: datacard ability ({c['name']})"
                        break
                if definition:
                    break
            if definition:
                break
            for r in raw.get("factionRules", []):
                if r["name"].strip().lower() == s["name"].strip().lower():
                    definition, defined_in = r["text"], f"{team_id}: faction rule"
                    break
            if definition:
                break
            for t in raw.get("tooltips", {}).values():
                if t["kind"] == "term" and t["title"].strip().lower() == s["name"].strip().lower():
                    definition, defined_in = t["text"], f"{team_id}: tooltip glossary"
                    break
            if definition:
                break
        out[rid] = {
            "id": rid,
            "name": s["name"],
            "teams": sorted(s["teams"]),
            "forms": sorted(s["raw"]),
            "definition": definition,
            "definedIn": defined_in,
            "uses": sorted(set(s["usedBy"])),
        }
        if not definition:
            # No printed definition anywhere. Record where the name IS mentioned
            # so the team module author can find the governing rule. (`PSYCHIC`
            # is the archetypal case: a tag rule with no standalone entry, read
            # by other rules such as Anti-PSYKER and Weapons of the Witch Hunters.)
            refs: list[str] = []
            needle = s["name"].lower()
            for team_id, raw in sorted(raws.items()):
                for kind, blocks in (("faction rule", raw.get("factionRules", [])),
                                     ("strategy ploy", raw.get("strategyPloys", [])),
                                     ("firefight ploy", raw.get("firefightPloys", [])),
                                     ("equipment", raw.get("equipment", []))):
                    for b in blocks:
                        if needle in (b.get("text") or "").lower():
                            refs.append(f"{team_id}: {kind} '{b['name']}'")
                for c in raw["datacards"]:
                    for a in c.get("abilities", []):
                        if needle in (a.get("text") or "").lower():
                            refs.append(f"{team_id}: {c['name']} ability '{a['name']}'")
            out[rid]["unresolved"] = True
            out[rid]["referencedIn"] = refs[:12]
    return out


# ==========================================================================


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    if not os.path.isdir(RAW_DIR):
        print(f"FATAL: {RAW_DIR} missing — run tools/teams/scrape_wahapedia.py first",
              file=sys.stderr)
        return 2
    os.makedirs(OUT_DIR, exist_ok=True)

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    raws: dict[str, dict] = {}
    for fn in sorted(os.listdir(RAW_DIR)):
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(RAW_DIR, fn), encoding="utf-8") as f:
            d = json.load(f)
        raws[d["slug"]] = d

    rare_sink: dict = {}
    teams: dict[str, dict] = {}
    index: list[dict] = []

    for slug, raw in sorted(raws.items()):
        if wanted and slug not in wanted:
            continue
        notes: list[str] = []
        if raw.get("degraded"):
            notes.append(f"built from the degraded {raw['source']} fallback, not live HTML")

        anchor_to_card: dict[str, str] = {}
        cards = []
        for rc in raw["datacards"]:
            c = build_datacard(raw, rc, rare_sink, notes)
            cards.append(c)
            if rc.get("anchor"):
                anchor_to_card[rc["anchor"]] = c["id"]

        ids = [c["id"] for c in cards]
        if len(set(ids)) != len(ids):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            notes.append(f"duplicate datacard ids after slugification: {dupes}")

        selection = build_selection(raw, cards, anchor_to_card, notes)

        team = {
            "id": slug,
            "name": raw["name"],
            "faction": raw.get("faction", ""),
            "grandFaction": raw.get("grandFaction", ""),
            "archetypes": raw.get("archetypes", []),
            "booksVersion": raw.get("booksVersion", ""),
            "books": raw.get("books", []),
            "sourceUrl": raw["sourceUrl"],
            "scrapedAt": raw["scrapedAt"],
            "source": raw.get("source", ""),
            "selection": selection,
            "datacards": cards,
            "factionRules": build_blocks(raw.get("factionRules", []), slug, "rule",
                                         rare_sink, notes),
            "strategyPloys": build_blocks(raw.get("strategyPloys", []), slug, "sp",
                                          rare_sink, notes, cp=1),
            "firefightPloys": build_blocks(raw.get("firefightPloys", []), slug, "fp",
                                           rare_sink, notes, cp=1),
            "equipment": build_blocks(raw.get("equipment", []), slug, "eq",
                                      rare_sink, notes),
            "markerGuide": raw.get("markerGuide", ""),
            "notes": notes,
        }
        if not team["archetypes"]:
            notes.append(f"no archetype list on the page (div.archetype = {raw.get('archetypeRaw','')!r})")
        teams[slug] = team

    rare = resolve_rare(rare_sink, teams, raws)

    for slug, team in teams.items():
        team["rareWeaponRules"] = sorted({
            r["id"] for c in team["datacards"] for w in c["weapons"]
            for p in w["profiles"] for r in p["rules"] if r["id"] not in UNIVERSAL})
        with open(os.path.join(OUT_DIR, slug + ".json"), "w", encoding="utf-8") as f:
            json.dump(team, f, indent=1, ensure_ascii=False)
            f.write("\n")
        index.append({
            "id": slug, "name": team["name"], "faction": team["faction"],
            "grandFaction": team["grandFaction"], "archetypes": team["archetypes"],
            "booksVersion": team["booksVersion"],
            "datacards": len(team["datacards"]),
            "strategyPloys": len(team["strategyPloys"]),
            "firefightPloys": len(team["firefightPloys"]),
            "equipment": len(team["equipment"]),
            "slots": team["selection"]["slots"],
            "notes": len(team["notes"]),
        })

    with open(os.path.join(OUT_DIR, "_index.json"), "w", encoding="utf-8") as f:
        json.dump({"generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                   "teams": index}, f, indent=1, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(OUT_DIR, "_rare-weapon-rules.json"), "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "universal": sorted(UNIVERSAL),
            "rules": [rare[k] for k in sorted(rare)],
        }, f, indent=1, ensure_ascii=False)
        f.write("\n")

    unresolved = [k for k, v in rare.items() if v.get("unresolved")]
    print(f"wrote {len(teams)} teams to data/teams/")
    print(f"rare weapon rules: {len(rare)} ({len(unresolved)} without a definition"
          f"{': ' + ', '.join(unresolved) if unresolved else ''})")
    noted = sum(len(t["notes"]) for t in teams.values())
    print(f"notes recorded: {noted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
