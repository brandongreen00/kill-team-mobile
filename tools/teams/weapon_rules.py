"""
Weapon-rule token parser.

Turns the verbatim `WR` cell of a Wahapedia datacard weapon row into
`WeaponRule[]` as declared in src/core/types.ts:

    { id: WeaponRuleId, x?: number, dist?: number, only?: string, raw: string }

The 23 universal rules are the Appendix › WEAPON RULES list
(docs/context-pack/research/core-rules/appendix.txt), transcribed verbatim in
UNIVERSAL below. `Piercing Crits x` and `Seek Light` are the two declared
sub-forms and map to the distinct ids `PiercingCrits` / `SeekLight`.

Anything else is a RARE rule: it keeps a stable PascalCase id and is emitted to
data/teams/_rare-weapon-rules.json together with the team(s) that use it and the
verbatim definition text. Nothing is ever dropped and nothing becomes `_unknown`.
"""

from __future__ import annotations

import re

# id -> takes a numeric parameter?
UNIVERSAL: dict[str, bool] = {
    "Accurate": True,
    "Balanced": False,
    "Blast": True,      # inches
    "Brutal": False,
    "Ceaseless": False,
    "Devastating": True,
    "Heavy": False,     # optional "(x only)" restriction
    "Hot": False,
    "Lethal": True,     # "5+"
    "Limited": True,
    "Piercing": True,
    "PiercingCrits": True,
    "Punishing": False,
    "Range": True,      # inches
    "Relentless": False,
    "Rending": False,
    "Saturate": False,
    "Seek": False,
    "SeekLight": False,
    "Severe": False,
    "Shock": False,
    "Silent": False,
    "Stun": False,
    "Torrent": True,    # inches
}

# printed spelling -> id (longest first at match time)
_NAME_TO_ID = {
    "piercing crits": "PiercingCrits",
    "seek light": "SeekLight",
    **{k.lower(): k for k in UNIVERSAL if k not in ("PiercingCrits", "SeekLight")},
}

_SPLIT = re.compile(r",(?![^()]*\))")
_MARKER = re.compile(r"(\*+|\^\d+(?:,\d+)*)\s*$")
_DIST_PREFIX = re.compile(r'^(\d+(?:\.\d+)?)\s*"\s+')
_ONLY = re.compile(r"\(([^)]*?)\s+only\)\s*$", re.I)
_NUM = re.compile(r'^(.*?)\s+(\d+(?:\.\d+)?)\s*(?:"|\+)?$')


def rare_id(name: str) -> str:
    """'Concealed Position' -> 'ConcealedPosition'; 'Anti-PSYKER' -> 'AntiPSYKER'."""
    parts = re.split(r"[^0-9A-Za-z]+", name)
    out = []
    for p in parts:
        if not p:
            continue
        out.append(p if p.isupper() or p[0].isupper() else p[0].upper() + p[1:])
    return "".join(out) or "Unnamed"


def parse_token(tok: str) -> dict | None:
    """One comma-separated WR token -> a rule dict (plus scraper-only extras
    `rare` and `marker`, which normalise.py strips before writing)."""
    raw = tok.strip()
    if not raw or raw == "-":
        return None
    body = raw

    marker = ""
    m = _MARKER.search(body)
    if m:
        marker = m.group(1)
        body = body[: m.start()].strip()

    dist = None
    m = _DIST_PREFIX.match(body)
    if m:
        dist = float(m.group(1))
        body = body[m.end():].strip()

    only = None
    m = _ONLY.search(body)
    if m:
        only = m.group(1).strip()
        # canonicalise the printed casing ("Dash Only" vs "Dash only")
        only = only[0].upper() + only[1:] if only else only
        body = body[: m.start()].strip()

    x = None
    m = _NUM.match(body)
    if m and m.group(1).strip():
        name, num = m.group(1).strip(), m.group(2)
        if name.lower() in _NAME_TO_ID:
            body, x = name, float(num) if "." in num else int(num)
    lookup = body.lower()

    if lookup in _NAME_TO_ID:
        rid = _NAME_TO_ID[lookup]
        rule: dict = {"id": rid, "raw": raw}
        if x is not None:
            rule["x"] = x
        if dist is not None:
            rule["dist"] = dist
        if only is not None:
            rule["only"] = only
        rule["rare"] = False
        rule["marker"] = marker
        rule["name"] = rid
        return rule

    rule = {"id": rare_id(body), "raw": raw}
    if x is not None:
        rule["x"] = x
    if dist is not None:
        rule["dist"] = dist
    if only is not None:
        rule["only"] = only
    rule["rare"] = True
    rule["marker"] = marker
    rule["name"] = body
    return rule


def parse_wr(wr: str) -> list[dict]:
    if not wr or wr.strip() in ("-", ""):
        return []
    out = []
    for tok in _SPLIT.split(wr):
        r = parse_token(tok)
        if r:
            out.append(r)
    return out


def public_rule(rule: dict) -> dict:
    """Drop the scraper-only keys so the JSON matches `WeaponRule` exactly."""
    out = {"id": rule["id"]}
    for k in ("x", "dist", "only"):
        if k in rule:
            out[k] = rule[k]
    out["raw"] = rule["raw"]
    return out
