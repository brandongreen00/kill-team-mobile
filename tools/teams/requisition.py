"""
Requisitioned operatives — a selection group filled from a *faction rule* rather
than from the printed selection list.

INQUISITORIAL AGENT prints:

    5 INQUISITORIAL AGENT operatives selected from the list above, or
    REQUISITIONED operatives from one group in the Inquisitorial Requisition
    faction rule (you cannot select REQUISITIONED operatives from different
    groups).

and the faction rule then prints one selection list per group (DEATH KORPS,
EXACTION SQUAD, IMPERIAL NAVY BREACHER, KASRKIN, SISTER OF SILENCE, TEMPESTUS
SCION), each with its own count, options, footnotes and constraints:

    Death Korps

    6 DEATH KORPS operatives selected from the following list:

    BRUISER
    CONFIDANT with one of the following options:
    Boltgun or lasgun; bayonet
    ...
    Other than TROOPER operatives, your kill team can only include each
    operative on this list once.
    * You cannot select more than three of these operatives combined.

This module transcribes those printed sub-lists into the same entry shape the
selection list uses, so the app's one shared validator reads them with no
special cases. Nothing is reconstructed: the roles, counts, options and
constraints all come from the printed text, and each role is resolved to a REAL
datacard — on this team's own page when the cards are printed there (SISTER OF
SILENCE, TEMPESTUS SCION) and otherwise in the donor kill team's committed JSON
(`death-korps`, `exaction-squad`, `imperial-navy-breacher`, `kasrkin`). A role
that cannot be resolved is recorded in `unresolved`, never invented.

The faction rule's own keyword-replacement clause ("These operatives have their
faction keyword replaced in all instances on their datacards with INQUISITORIAL
AGENT") is applied by the app when it merges a donor's datacards in, not here —
the donor JSON stays the single copy of each datacard.
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from constraints import parse_constraints  # noqa: E402
from selection import RE_CHOICE, norm_weapon, num, slugify, split_loadout, strip_marker  # noqa: E402

# "…, or REQUISITIONED operatives from one group in the Inquisitorial Requisition
#  faction rule (you cannot select REQUISITIONED operatives from different groups)."
RE_ALTERNATIVE = re.compile(
    r"(?i)\bor\s+([A-Z][A-Z0-9'’\- ]*[A-Z])\s+operatives?\s+from\s+one\s+group\s+"
    r"in\s+the\s+(.+?)\s+faction rule")

# "These operatives have their faction keyword replaced in all instances on their
#  datacards with INQUISITORIAL AGENT (unless they already have it)."
RE_KEYWORD_SWAP = re.compile(
    r"(?i)faction keyword replaced in all instances on their datacards with "
    r"([A-Z][A-Z0-9'’\- ]*[A-Z])")

RE_SUBLIST_HEAD = re.compile(
    r"(?i)^(\d+)\s+(.+?)\s+operatives?\s+selected from the following list\s*:?\s*$")

_ROLE_CHARS = re.compile(r"^[A-Z0-9][A-Z0-9'’\.\-/ ]*$")


def _is_role(text: str) -> bool:
    """A printed role is ALL CAPS ('R-VR CYBER-MASTIFF', 'C.A.T. UNIT')."""
    return bool(text) and bool(_ROLE_CHARS.match(text)) and any(c.isalpha() for c in text)


def _plain_role(role: str, group_keyword: str) -> str:
    """'MEDIC KASRKIN' -> 'MEDIC'.

    The requisition lists print the group name on some rows and not others
    ('GUNNER KASRKIN' next to 'GUNNER with grenade launcher…'), and the group's
    own constraints name the bare role ('Other than TROOPER operatives…'), so
    the redundant group word is dropped. The printed line is kept in rawText."""
    want = role.strip()
    if want.upper().endswith(" " + group_keyword):
        return want[: -(len(group_keyword) + 1)].strip()
    if want.upper().startswith(group_keyword + " "):
        return want[len(group_keyword) + 1:].strip()
    return want


def _entry_shape(role: str, raw: str, marker: str) -> dict:
    return {
        "role": role,
        "datacardId": "",
        "count": 1,
        "isLeader": False,
        # Uniqueness is printed per group; a group that prints none (SISTER OF
        # SILENCE) lets the same operative be taken more than once.
        "uniqueUnlessRole": False,
        "selectionCost": 1,
        "footnoteGroup": marker or None,
        "requires": [],
        "loadoutMode": "fixed",
        "fixedWeapons": [],
        "fixedChoiceGroups": [],
        "alwaysWeapons": [],
        "loadouts": [],
        "optionGroups": [],
        "rawText": raw,
    }


def _split_blocks(lines: list[str], keywords: list[str]) -> list[tuple[str, str, list[str]]]:
    """-> [(group keyword, printed heading, body lines)].

    Part one of the rule declares the groups in CAPS; part two prints each one
    again as a Title Case heading followed by its selection list. The heading is
    therefore the line whose upper() is a declared keyword but which is not
    itself the CAPS declaration."""
    upper = {k.upper(): k for k in keywords}
    heads: list[tuple[int, str, str]] = []
    for i, line in enumerate(lines):
        key = upper.get(line.strip().upper())
        if key and line.strip() != line.strip().upper():
            heads.append((i, key, line.strip()))
    out = []
    for n, (i, key, printed) in enumerate(heads):
        end = heads[n + 1][0] if n + 1 < len(heads) else len(lines)
        out.append((key, printed, [l for l in lines[i + 1:end] if l.strip()]))
    return out


def _declared_keywords(lines: list[str]) -> list[str]:
    """The CAPS group names printed between the rule's opening sentence and its
    keyword-replacement paragraph."""
    out: list[str] = []
    for line in lines:
        t = line.strip()
        if not t:
            continue
        if t.lower().startswith("these operatives have their faction keyword"):
            break
        if len(t.split()) <= 5 and _is_role(t) and out is not None and t.endswith(":") is False:
            if t not in out:
                out.append(t)
    return out


def _resolve_card(role: str, group_keyword: str, cards: list[dict],
                  notes: list[str], where: str) -> str:
    """Match a printed role to a real datacard by its role keyword.

    The requisition lists sometimes append the group name ('MEDIC KASRKIN'), so
    that word is stripped before matching. Ambiguity is reported, never guessed."""
    want = role.strip()
    if want.upper().endswith(" " + group_keyword):
        want = want[: -(len(group_keyword) + 1)].strip()
    elif want.upper().startswith(group_keyword + " "):
        want = want[len(group_keyword) + 1:].strip()
    hits = [c for c in cards if want.upper() in [k.upper() for k in c["keywords"][1:]]]
    if len(hits) == 1:
        return hits[0]["id"]
    if not hits:
        notes.append(f"{where}: no datacard carries the '{want}' keyword")
        return ""
    # Prefer the card whose LAST keyword is the role — that is its own role keyword
    # rather than a shared one (EXACTION SQUAD's CHIRURGANT also carries MEDIC).
    exact = [c for c in hits if c["keywords"][-1].upper() == want.upper()]
    if len(exact) == 1:
        return exact[0]["id"]
    notes.append(f"{where}: '{want}' matches {len(hits)} datacards "
                 f"({', '.join(c['id'] for c in hits)}) — left unresolved")
    return ""


def _parse_block(keyword: str, printed: str, body: list[str], cards: list[dict],
                 source_team: str | None, idbase: str, notes: list[str]) -> dict:
    """One printed requisition group -> a selection-list-shaped block."""
    known: dict[str, str] = {}
    for c in cards:
        for w in c["weapons"]:
            known.setdefault(norm_weapon(w["name"]), w["name"])

    count = 0
    head_raw = ""
    entries: list[dict] = []
    prose: list[str] = []
    collecting: dict | None = None
    opt_notes: list[str] = []

    for line in body:
        text = line.strip()
        m = RE_SUBLIST_HEAD.match(text)
        if m and not entries:
            count = int(m.group(1))
            head_raw = text
            continue
        if text.startswith("*") or re.match(r"^\^\d", text):
            prose.append(text)
            collecting = None
            continue
        core, marker = strip_marker(text)
        role, _sep, qual = core.partition(" with ")
        if _is_role(role.strip()) and (qual or _is_role(core)):
            plain = _plain_role(role.strip(), keyword)
            entry = _entry_shape(plain, text, marker)
            entry["datacardId"] = _resolve_card(role.strip(), keyword, cards, notes,
                                                f"{idbase}:{role.strip()}")
            if qual and RE_CHOICE.search(qual.strip()):
                entry["loadoutMode"] = "choice"
                collecting = entry
            elif qual:
                fixed, groups, unresolved = split_loadout(qual.strip(" .:"), known)
                entry["fixedWeapons"] = fixed
                entry["fixedChoiceGroups"] = [
                    {"id": f"{idbase}.e{len(entries)+1}.g{gi}",
                     "label": " or ".join(g),
                     "choices": [{"id": f"{idbase}.e{len(entries)+1}.g{gi}o{ci}",
                                  "label": w, "weapons": [w]}
                                 for ci, w in enumerate(g, 1)]}
                    for gi, g in enumerate(groups, 1)
                ]
                if unresolved:
                    notes.append(f"{idbase}:{role.strip()}: '{unresolved}' is not a weapon on "
                                 f"the datacard (left off the entry)")
                collecting = None
            else:
                collecting = None
            entries.append(entry)
            continue
        if collecting is not None and not text.endswith("."):
            lab, _mk = strip_marker(text)
            w, g, u = split_loadout(lab, known)
            opt = {"id": f"{idbase}.e{entries.index(collecting)+1}.opt{len(collecting['loadouts'])+1}",
                   "label": lab, "weapons": w}
            if u:
                opt_notes.append(f"{idbase}: option '{lab}' names {u}, not a datacard weapon")
            collecting["loadouts"].append(opt)
            continue
        collecting = None
        prose.append(text)

    cons, footnotes = parse_constraints("\n".join(prose), idbase)
    unique_except = next((c for c in cons if c["kind"] == "uniqueExcept"), None)
    for e in entries:
        if unique_except is not None:
            e["uniqueUnlessRole"] = e["role"] not in unique_except["roles"]
        for c in cons:
            if c["kind"] == "requires" and c["role"] == e["role"]:
                e["requires"].append(c["requiresRole"])
            if e["footnoteGroup"] and c["kind"] == "halfSelection" and c["group"] == e["footnoteGroup"]:
                e["selectionCost"] = 0.5
    # Every datacard weapon no option of that datacard names is carried anyway.
    named: dict[str, set[str]] = {}
    for e in entries:
        acc = named.setdefault(e["datacardId"], set())
        acc |= {norm_weapon(w) for w in e["fixedWeapons"]}
        for o in e["loadouts"]:
            acc |= {norm_weapon(w) for w in o["weapons"]}
        for g in e["fixedChoiceGroups"]:
            for o in g["choices"]:
                acc |= {norm_weapon(w) for w in o["weapons"]}
    by_id = {c["id"]: c for c in cards}
    for e in entries:
        card = by_id.get(e["datacardId"])
        e["alwaysWeapons"] = ([w["name"] for w in card["weapons"]
                               if norm_weapon(w["name"]) not in named.get(e["datacardId"], set())]
                              if card else [])

    notes.extend(opt_notes)
    return {
        "id": slugify(printed),
        "name": printed,
        "keyword": keyword,
        "sourceTeam": source_team,
        "count": count,
        "rawText": head_raw,
        "entries": entries,
        "constraints": cons,
        "footnotes": footnotes,
        "unresolved": sorted({e["role"] for e in entries if not e["datacardId"]}),
    }


def attach_requisition(team: dict, all_teams: dict[str, dict], notes: list[str]) -> None:
    """Fill in `selection.requisition` when a group is printed as
    "… or <KEYWORD> operatives from one group in the <X> faction rule"."""
    sel = team["selection"]
    target = None
    alt = None
    for g in sel["groups"]:
        m = RE_ALTERNATIVE.search(g.get("rawText", ""))
        if m:
            target, alt = g, m
            break
    if target is None or alt is None:
        return

    keyword, rule_name = alt.group(1).strip(), alt.group(2).strip()
    rule = next((r for r in team["factionRules"]
                 if r["name"].strip().lower() == rule_name.lower()), None)
    if rule is None:
        notes.append(f"selection group {target['index']} points at the '{rule_name}' faction "
                     f"rule, which is not on this page — {keyword} operatives unavailable")
        return

    lines = rule["text"].split("\n")
    keywords = _declared_keywords(lines)
    blocks = _split_blocks(lines, keywords)
    if not blocks:
        notes.append(f"'{rule_name}' declares {keywords} but prints no selection list for them")
        return

    groups = []
    for keyword_name, printed, body in blocks:
        home = [c for c in team["datacards"] if keyword_name.upper() in
                [k.upper() for k in c["keywords"]]]
        source_team = None
        cards = home
        if not home:
            donor = next((s for s, t in sorted(all_teams.items())
                          if any(keyword_name.upper() == (c["keywords"][0] or "").upper()
                                 for c in t["datacards"])), None)
            if donor is None:
                notes.append(f"'{printed}' requisition group: no datacards for {keyword_name} "
                             f"on this page or in any built kill team — group left unresolved")
                groups.append({"id": slugify(printed), "name": printed, "keyword": keyword_name,
                               "sourceTeam": None, "count": 0, "rawText": "", "entries": [],
                               "constraints": [], "footnotes": {},
                               "unresolved": ["<no datacards>"]})
                continue
            source_team = donor
            cards = all_teams[donor]["datacards"]
        groups.append(_parse_block(keyword_name, printed, body, cards, source_team,
                                   f"{team['id']}.req.{slugify(printed)}", notes))

    for g in groups:
        for e in g["entries"]:
            e["group"] = target["index"]
            e["requisitionGroup"] = g["id"]

    swap = RE_KEYWORD_SWAP.search(rule["text"])
    swap_sentence = ""
    if swap:
        for para in rule["text"].split("\n\n"):
            for sentence in re.split(r"(?<=\.)\s+", para.strip()):
                if RE_KEYWORD_SWAP.search(sentence):
                    swap_sentence = sentence.strip()
                    break
            if swap_sentence:
                break
    else:
        notes.append(f"'{rule_name}' does not print a faction-keyword replacement — "
                     f"requisitioned datacards keep their own keywords")

    target["requisition"] = True
    sel["requisition"] = {
        "ruleId": rule["id"],
        "ruleName": rule["name"],
        "keyword": keyword,
        "oneGroupOnly": True,
        "rawText": target["rawText"],
        "factionKeyword": swap.group(1).strip() if swap else "",
        "keywordRuleText": swap_sentence,
        "groups": groups,
    }
    sel["constraints"].append({
        "kind": "oneRequisitionGroup",
        "keyword": keyword,
        "text": target["rawText"].strip(),
    })
