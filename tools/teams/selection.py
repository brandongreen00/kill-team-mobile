"""
Parser for the `Operatives` (kill-team selection) section of a Wahapedia KT3
team page.

The section is a two-level `<ul>` tree plus free text. This module turns it into
the structured `selection` block of the per-team JSON contract — roles, loadout
options, selection costs, footnote groups and constraints — so that no team
module has to re-read English prose at runtime.

Grammar covered (every phrasing observed across the 48 live pages):

  group headers
    "1 <ROLE> operative"                                   fixed single operative
    "1 <FACTION> operative selected from the following list:"
    "N <FACTION> operatives selected from the following list:"
    "2 <ROLE> operatives (still counts as one selection)"

  loadouts, in the order they appear inside one <li>
    "with one of the following options:"          -> loadouts (pick one)
    "with the following option:"                  -> loadouts (single)
    "equipped with one of the following options:" -> loadouts (pick one)
    "with one option from each of the following:" -> optionGroups (one per group)
    "Or one option from each of the following:"   -> mode 'either'
    "Or the following option:"                    -> mode 'either'
    "equipped with fists and one of the following options:"  -> fixedWeapons + loadouts
    "<ROLE> with meltagun and gun butt"           -> fixedWeapons on a list entry

  per-entry riders
    "(counts as two|three selections)"            selectionCost
    "(still counts as one selection)"             selectionCost 1 for an N>1 entry
    "*" / "^1" footnote markers                   footnoteGroup

  free-text constraints (after the list)
    "Other than X[, Y] operatives, your kill team can only include each operative
     on this list once."                          uniqueExcept
    "...can only include up to two GUNNER operatives"            maxCount
    "...can only include up to one fusion pistol"                maxItem
    "(each must have a different option)"                        distinctOptions
    "You cannot select more than four of these operatives combined."  groupCap
    "...can only include a X operative if it also includes a Y operative"  requires
    "You cannot select this option and this operative."           exclusive
    "These operatives count as half a selection each..."          halfSelection
  anything else                                                   custom + hook
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wahapedia_html import inline_text, text_of  # noqa: E402

NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14,
}


def num(word: str) -> int | None:
    word = word.strip().lower()
    if word.isdigit():
        return int(word)
    return NUMBER_WORDS.get(word)


def slugify(s: str) -> str:
    s = s.lower().replace("’", "").replace("'", "")
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return re.sub(r"-{2,}", "-", s) or "x"


# --------------------------------------------------------------------------
# 1. <ul>/<li> tree
# --------------------------------------------------------------------------

_LIST_TAG = re.compile(r"(?i)(<ul\b[^>]*>|</ul>|<li\b[^>]*>|</li>)")


def _parse_items(html: str, pos: int) -> tuple[list[dict], int]:
    """Parse the body of a <ul>, returning (items, index just past </ul>).
    Each item is {'parts': [ {'type':'text','html':..} | {'type':'list','items':[..]} ]}."""
    items: list[dict] = []
    cur: list[dict] | None = None
    buf_start = pos
    i = pos
    while i < len(html):
        m = _LIST_TAG.search(html, i)
        if not m:
            break
        tag = m.group(1).lower()
        chunk = html[buf_start:m.start()]
        if chunk.strip():
            if cur is not None:
                cur.append({"type": "text", "html": chunk})
            elif re.sub(r"(?s)<[^>]+>", "", chunk).strip():
                # text printed at list level, between two <li>s (Blades of Khaine
                # prints "Or one option from each of the following:" this way)
                items.append({"parts": [{"type": "text", "html": chunk}], "listLevel": True})
        if tag.startswith("<li"):
            if cur is not None:
                items.append({"parts": cur})
            cur = []
            buf_start = m.end()
            i = m.end()
        elif tag == "</li>":
            if cur is not None:
                items.append({"parts": cur})
            cur = None
            buf_start = m.end()
            i = m.end()
        elif tag.startswith("<ul"):
            sub, after = _parse_items(html, m.end())
            if cur is not None:
                cur.append({"type": "list", "items": sub})
            elif items:
                # malformed source: the nested <ul> is a SIBLING of the <li> it
                # belongs to (Blades of Khaine). Attach it to that <li>.
                items[-1]["parts"].append({"type": "list", "items": sub})
            buf_start = after
            i = after
        else:  # </ul>
            if cur is not None:
                items.append({"parts": cur})
            return items, m.end()
    if cur is not None:
        items.append({"parts": cur})
    return items, len(html)


def parse_top_list(html: str) -> tuple[list[dict], str]:
    """-> (top-level <li> items, the free text that follows the list)."""
    m = re.search(r"(?i)<ul\b[^>]*>", html)
    if not m:
        return [], text_of(html)
    items, after = _parse_items(html, m.end())
    return items, text_of(html[:m.start()] + "\n" + html[after:])


def own_html(item: dict) -> str:
    return "".join(p["html"] for p in item["parts"] if p["type"] == "text")


# --------------------------------------------------------------------------
# 2. role / marker extraction
# --------------------------------------------------------------------------

_ROLE_SPAN = re.compile(r'(?s)<span class="kwb[^"]*">(.*?)</span>')
_ANCHOR = re.compile(r'(?s)<a class="kwbOne" href="[^"#]*#([^"]+)"[^>]*>(.*?)</a>')
_FACTION_SPAN = re.compile(r'(?s)<span class="(?:inb )?fkwb[^"]*">(.*?)</span>')


# the faction-keyword span wraps a nested <span class="fskull"></span>
_FKWB = re.compile(r'(?s)<span class="(?:inb )?fkwb[^"]*">(?:[^<]|<span[^>]*>[^<]*</span>)*</span>')
_EMPTY_KWB = re.compile(r'(?s)<span class="kwb[^"]*">\s*</span>')
_SKIP = re.compile(r'(?s)\s*(?:<a\b[^>]*>|</a>|</span>|<b>|</b>|<i>|</i>|<br\s*/?>'
                   r'|<span class="tooltip[^"]*"[^>]*>)\s*')
_ROLE_WORD = re.compile(r'(?s)\s*<span class="kwb[^"]*">([^<]*)</span>\s*')


def leading_role(h: str) -> tuple[str, str, str]:
    """-> (role, datacard anchor, remaining html after the role spans).

    The role is the opening run of `.kwb` spans; the faction keyword (`.fkwb`,
    which always precedes it) is dropped, and a wrapping `.kwbOne` anchor names
    the datacard."""
    anchor = ""
    am = _ANCHOR.search(h)
    if am and am.start() < 400:
        anchor = am.group(1)
    scan = _EMPTY_KWB.sub(" ", _FKWB.sub(" ", h))
    words: list[str] = []
    pos = 0
    while True:
        m = _SKIP.match(scan, pos)
        if m and m.end() > pos:
            pos = m.end()
            continue
        m = _ROLE_WORD.match(scan, pos)
        if not m:
            break
        pos = m.end()
        w = inline_text(m.group(1))
        if w:
            words.append(w)
    return " ".join(words), anchor, scan[pos:]


_MARK = r"(\*+|\^\d+(?:,\d+)*)"


def strip_marker(txt: str) -> tuple[str, str]:
    """Strip a '*' / '^1' / '^1,2' footnote marker -> (text, marker).

    The marker follows the role, so it lands at the end of a bare entry
    ('SHARPSHOOTER*') and at the start of the qualifier when one follows
    ('* with one of the following options:')."""
    t = txt.strip()
    m = re.search(_MARK + r"\s*$", t)
    if m:
        return t[: m.start()].strip(), m.group(1)
    m = re.match(r"^" + _MARK + r"(?=\s|$)", t)
    if m:
        return t[m.end():].strip(), m.group(1)
    return t, ""


# --------------------------------------------------------------------------
# 3. weapon-name resolution against the datacard
# --------------------------------------------------------------------------

_HYPHENS = dict.fromkeys(map(ord, "‐‑‒–—−"), "-")


def norm_weapon(s: str) -> str:
    s = s.translate(_HYPHENS).replace("’", "'").replace(" ", " ")
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s)          # drop a profile suffix
    s = re.sub(r"[^a-z0-9&' ]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def split_loadout(label: str, known: dict[str, str]) -> tuple[list[str], list[str]]:
    """'Shuriken pistol; scorpion’s claw and chainsword' -> the two real weapons.

    `known` maps normalised datacard weapon names -> the printed name. A part is
    only split on ' and ' when the whole part is not itself a datacard weapon,
    which is what keeps 'scorpion's claw and chainsword' in one piece.
    -> (resolved printed names, unresolved fragments)"""
    resolved: list[str] = []
    unresolved: list[str] = []

    def take(frag: str) -> bool:
        k = norm_weapon(frag)
        if not k:
            return True
        if k in known:
            resolved.append(known[k])
            return True
        return False

    for part in re.split(r"\s*;\s*", label):
        part = part.strip(" .")
        if not part:
            continue
        if take(part):
            continue
        subs = re.split(r"\s+and\s+", part)
        if len(subs) > 1 and all(norm_weapon(s) in known for s in subs):
            for s in subs:
                take(s)
            continue
        subs = re.split(r"\s*,\s*", part)
        if len(subs) > 1 and all(norm_weapon(s) in known for s in subs):
            for s in subs:
                take(s)
            continue
        unresolved.append(part)
    return resolved, unresolved


# --------------------------------------------------------------------------
# 4. loadout / option-group extraction from one <li>
# --------------------------------------------------------------------------

RE_CHOICE = re.compile(r"(?i)(one of the following|the following options?)\s*:?\s*$")
RE_EACH = re.compile(r"(?i)one option from each of the following\s*:?\s*$")
RE_LIST = re.compile(r"(?i)(?:selected from|in) the following list\s*(?:\*+|\^\d+(?:,\d+)*)?\s*:?\s*$")
RE_OR_LEAD = re.compile(r"(?i)^\s*or\b")


_COUNT_LEAD = re.compile(r"(?s)^\s*(\d+)\s+")
_FIXED_CUT = re.compile(
    r"(?i)\s*(?:and\s+)?(?:one of the following|one option from each|the following option)")


def parse_entry(item: dict, known: dict[str, str], idbase: str) -> dict:
    """One <li> that names a role — either a top-level group header for a fixed
    operative, or a member of a `selected from the following list` list."""
    parts = item["parts"]
    first = next((p for p in parts if p["type"] == "text"), None)

    count = 1
    head_html = first["html"] if first else ""
    raw_head = text_of(head_html)
    cm = _COUNT_LEAD.match(head_html)
    if cm:
        count = int(cm.group(1))
        head_html = head_html[cm.end():]
    role, anchor, rest_html = leading_role(head_html)

    notes: list[str] = []
    loadouts: list[dict] = []
    option_groups: list[dict] = []
    nested: list[dict] | None = None
    head_text = ""
    pending = ""

    for p in parts:
        if p["type"] == "text":
            pending = text_of(rest_html) if p is first else text_of(p["html"])
            if p is first:
                head_text = pending
            continue
        tail = pending.strip()
        if RE_LIST.search(tail):
            nested = p["items"]
        elif RE_EACH.search(tail):
            for gi, sub in enumerate([x for x in p["items"] if not x.get("listLevel")], 1):
                lab = text_of(own_html(sub))
                choices = []
                for ci, alt in enumerate(re.split(r"\s+or\s+", lab), 1):
                    alt = alt.strip(" .")
                    w, u = split_loadout(alt, known)
                    if u:
                        notes.append(f"unresolved weapon(s) in option '{alt}': {u}")
                    choices.append({"id": f"{idbase}.g{gi}o{ci}", "label": alt, "weapons": w})
                option_groups.append({"id": f"{idbase}.g{gi}", "label": lab, "choices": choices})
        else:
            sub_mode = "options"
            for sub in p["items"]:
                lab_raw = text_of(own_html(sub))
                if sub.get("listLevel"):
                    if RE_EACH.search(lab_raw.strip()):
                        sub_mode = "each"
                    elif RE_CHOICE.search(lab_raw.strip()):
                        sub_mode = "options"
                    continue
                if sub_mode == "each":
                    gi = len(option_groups) + 1
                    choices = []
                    for ci, alt in enumerate(re.split(r"\s+or\s+", lab_raw), 1):
                        alt = alt.strip(" .")
                        w, u = split_loadout(alt, known)
                        if u:
                            notes.append(f"unresolved weapon(s) in option '{alt}': {u}")
                        choices.append({"id": f"{idbase}.g{gi}o{ci}", "label": alt, "weapons": w})
                    option_groups.append({"id": f"{idbase}.g{gi}", "label": lab_raw,
                                          "choices": choices})
                    continue
                lab, marker = strip_marker(lab_raw)
                w, u = split_loadout(lab, known)
                if u:
                    notes.append(f"unresolved weapon(s) in option '{lab}': {u}")
                opt = {"id": f"{idbase}.opt{len(loadouts) + 1}", "label": lab, "weapons": w}
                if marker:
                    opt["footnoteGroup"] = marker
                loadouts.append(opt)
        pending = ""

    if loadouts and option_groups:
        mode = "either"          # "... Or one option from each of the following"
    elif option_groups:
        mode = "combine"
    elif loadouts:
        mode = "choice"
    else:
        mode = "fixed"

    qual, marker = strip_marker(head_text)
    cost = 1.0
    m = re.search(r"\(counts as (\w+) selections?\)", qual, re.I)
    if m:
        cost = float(num(m.group(1)) or 1)
    still_one = bool(re.search(r"\(still counts as one selection\)", qual, re.I))
    qual_clean = re.sub(r"\([^)]*\)", " ", qual)

    fixed: list[str] = []
    fm = re.search(r"(?i)\b(?:equipped with|with)\s+(.+)$", qual_clean)
    if fm:
        cand = _FIXED_CUT.split(fm.group(1))[0].strip(" .:,")
        if cand:
            w, u = split_loadout(cand, known)
            fixed = w
            if u:
                notes.append(f"unresolved fixed weapon(s) '{cand}': {u}")

    entry: dict = {
        "role": role,
        "datacardAnchor": anchor,
        "count": count,
        "fixedWeapons": fixed,
        "loadouts": loadouts,
        "optionGroups": option_groups,
        "loadoutMode": mode,
        "selectionCost": cost,
        "footnoteGroup": marker or None,
        "requires": [],
        "rawText": raw_head.strip(),
    }
    if still_one:
        entry["stillOneSelection"] = True
    if nested is not None:
        entry["_nested"] = nested
    if notes:
        entry["notes"] = notes
    return entry
