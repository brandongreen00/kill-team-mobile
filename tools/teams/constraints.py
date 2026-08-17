"""
Free-text -> structured selection constraints.

Everything the Operatives section says AFTER the <ul> tree is prose. This module
converts the recurring phrasings into the machine-readable `constraints` array of
the team JSON contract, and routes anything it cannot express structurally into
`{"kind":"custom","text":"<verbatim>","hook":"<slug>.<name>"}` so a team module
implements it explicitly rather than the rule being silently lost.
"""

from __future__ import annotations

import re

from selection import num, slugify

ROLE = r"[A-Z0-9][A-Z0-9'’\.\- ]*[A-Z0-9\.]"

RE_UNIQUE_EXCEPT = re.compile(
    r"(?i)other than (.+?) operatives?, your kill team can only include each operative on this list once")
RE_UNIQUE = re.compile(
    r"(?i)your kill team can only include each operative on this list once")
RE_MAX_ROLE = re.compile(
    r"(?i)(?:include |and )?up to (\w+) (%s) operatives?(?:\s*\(([^)]*)\))?" % ROLE)
RE_MAX_ITEM = re.compile(r"(?i)up to (\w+) ([a-z][^,.;]*?)(?=[,.;]|\s+and\s+up to|$)")
RE_GROUP_CAP = re.compile(
    r"(?i)you cannot select more than (\w+) (?:of these operatives|operatives with these weapons)? ?combined")
RE_REQUIRES = re.compile(
    r"(?i)(?:can |it can )?only include an? (%s) operative if it also includes an? (%s) operative" % (ROLE, ROLE))
RE_EXCLUSIVE = re.compile(r"(?i)you cannot select this option and this operative")
RE_HALF = re.compile(r"(?i)these operatives count as half a selection each")
RE_ONCE_PER_BATTLE = re.compile(
    r"(?i)you cannot select an option that includes an? (.+?) more than once per battle")
RE_DISTINCT = re.compile(r"(?i)each must have a different option")

# never split after a single-letter abbreviation ("C.A.T. UNIT" is one role)
_SENT = re.compile(r"(?<![A-Z][.])(?<=[.!?])\s+(?=[A-Z“\"‘'])")


def split_sentences(text: str) -> list[str]:
    out: list[str] = []
    for chunk in _SENT.split(text):
        chunk = chunk.strip()
        if chunk:
            out.append(chunk)
    return out


def split_roles(blob: str) -> list[str]:
    parts = re.split(r"\s*,\s*|\s+and\s+", blob)
    return [p.strip(" .") for p in parts if p.strip(" .")]


def parse_constraints(free_text: str, slug: str) -> tuple[list[dict], dict[str, str]]:
    """-> (constraints, footnote marker -> verbatim footnote text)."""
    constraints: list[dict] = []
    footnotes: dict[str, str] = {}
    seen: set[str] = set()

    def add(c: dict) -> None:
        key = repr(sorted(c.items(), key=lambda kv: kv[0]))
        if key not in seen:
            seen.add(key)
            constraints.append(c)

    for line in [ln.strip() for ln in free_text.split("\n") if ln.strip()]:
        m = re.match(r"^(\*+|\^\d+)\s*(.*)$", line)
        marker, body = (m.group(1), m.group(2)) if m else ("", line)
        if marker:
            footnotes[marker] = body.strip()
        for sent in split_sentences(body) or [body]:
            matched = False

            mm = RE_UNIQUE_EXCEPT.search(sent)
            if mm:
                add({"kind": "uniqueExcept", "roles": split_roles(mm.group(1))})
                matched = True
            elif RE_UNIQUE.search(sent):
                add({"kind": "uniqueExcept", "roles": []})
                matched = True

            for mm in RE_MAX_ROLE.finditer(sent):
                n = num(mm.group(1))
                if n is None:
                    continue
                add({"kind": "maxCount", "role": mm.group(2).strip(), "max": n})
                if mm.group(3) and RE_DISTINCT.search(mm.group(3)):
                    add({"kind": "distinctOptions", "role": mm.group(2).strip()})
                matched = True

            if not RE_MAX_ROLE.search(sent):
                for mm in RE_MAX_ITEM.finditer(sent):
                    n = num(mm.group(1))
                    item = mm.group(2).strip()
                    if n is None or not item or item.lower().startswith("of these"):
                        continue
                    add({"kind": "maxItem", "item": item, "max": n})
                    matched = True

            mm = RE_GROUP_CAP.search(sent)
            if mm and num(mm.group(1)) is not None:
                add({"kind": "groupCap", "group": marker or "*", "max": num(mm.group(1))})
                matched = True

            for mm in RE_REQUIRES.finditer(sent):
                add({"kind": "requires", "role": mm.group(1).strip(),
                     "requiresRole": mm.group(2).strip()})
                matched = True

            if RE_EXCLUSIVE.search(sent):
                add({"kind": "exclusive", "group": marker or "*", "text": sent})
                matched = True

            if RE_HALF.search(sent):
                add({"kind": "halfSelection", "group": marker or "*", "max": 1})
                matched = True

            mm = RE_ONCE_PER_BATTLE.search(sent)
            if mm:
                add({"kind": "maxItem", "item": mm.group(1).strip(), "max": 1,
                     "group": marker or None})
                matched = True

            if not matched and len(sent.split()) > 3:
                head = " ".join(re.sub(r"[^A-Za-z0-9 ]", " ", sent).split()[:6])
                add({"kind": "custom", "text": sent, "hook": f"{slug}.{slugify(head)}"})

    return constraints, footnotes
