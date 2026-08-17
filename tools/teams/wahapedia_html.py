"""
Shared HTML helpers for the Wahapedia KT3 scrape.

Pure text/regex utilities — no network, no file IO. Kept separate so
`scrape_wahapedia.py` (fetch + structure) and `normalise.py` (curate) can both
use the exact same text normalisation, which is what makes the pipeline
reproducible.

Selectors are documented in docs/context-pack/research/REPORT-kill-teams.md §4
and docs/context-pack/research/kill-teams/page-structure.md.
"""

from __future__ import annotations

import html as _html
import re

# --------------------------------------------------------------------------
# Text extraction
# --------------------------------------------------------------------------

_SCRIPTY = re.compile(r"(?is)<(script|style|noscript)\b[^>]*>.*?</\1>")
_AD_PLACEHOLDER = re.compile(r'(?is)<div id="ezoic-pub-ad-placeholder-\d+"[^>]*>.*?</div>')
_AD_YANDEX = re.compile(r'(?is)<div id="yandex_rtb_[^"]*"[^>]*>\s*</div>')
_COMMENT = re.compile(r"(?s)<!--.*?-->")

# Block-level elements whose close should become a newline.
_BLOCK_CLOSE = re.compile(r"(?i)</(p|div|tr|li|h[1-6]|table|thead|tbody|section|article|ul|ol)>")
_BLOCK_OPEN = re.compile(r"(?i)<(p|tr|li|h[1-6]|table|thead|tbody|ul|ol)\b[^>]*>")
_CELL_CLOSE = re.compile(r"(?i)</t[dh]>")
_BR = re.compile(r"(?i)<br\s*/?>")
_TAG = re.compile(r"<[^>]+>")

_WS_INLINE = re.compile(r"[ \t\xa0]+")
_WS_LINES = re.compile(r"\n[ \t]*")
_WS_BLANK = re.compile(r"\n{3,}")


def strip_chrome(h: str) -> str:
    """Remove scripts, styles, comments and the ad placeholders Wahapedia
    interleaves between sections. Without this the ad JS leaks verbatim into
    rule text (the first-pass context-pack scrape has exactly that bug)."""
    h = _SCRIPTY.sub("", h)
    h = _COMMENT.sub("", h)
    h = _AD_PLACEHOLDER.sub("", h)
    h = _AD_YANDEX.sub("", h)
    return h


def text_of(h: str, *, sep_cells: str = "\n") -> str:
    """HTML fragment -> plain text, preserving paragraph structure.

    Footnote markup is preserved as literal characters:
      <span class="ast">*</span> -> '*'      (already the literal char)
      <sup>1</sup>               -> '^1'     (so it survives whitespace folding)
    """
    if not h:
        return ""
    h = strip_chrome(h)
    h = re.sub(r"(?is)<sup\b[^>]*>\s*(.*?)\s*</sup>",
               lambda m: "^" + _TAG.sub("", m.group(1)).strip(), h)
    h = _BR.sub("\n", h)
    h = _CELL_CLOSE.sub(sep_cells, h)
    h = _BLOCK_OPEN.sub("\n", h)
    h = _BLOCK_CLOSE.sub("\n", h)
    h = _TAG.sub("", h)
    h = _html.unescape(h)
    h = h.replace("⌀", "")  # ⌀ diameter sign, handled by base parser
    h = _WS_INLINE.sub(" ", h)
    h = _WS_LINES.sub("\n", h)
    h = _WS_BLANK.sub("\n\n", h)
    return h.strip()


def inline_text(h: str) -> str:
    """Like text_of but collapses everything onto one line (names, stats)."""
    return " ".join(text_of(h).split())


# --------------------------------------------------------------------------
# Region slicing
# --------------------------------------------------------------------------


def anchor_pos(h: str, name: str) -> int:
    m = re.search(r'<a name="%s"\s*>' % re.escape(name), h)
    return m.start() if m else -1


def region(h: str, start: str, ends: list[str]) -> str:
    """Slice the HTML between <a name="start"> and the first of `ends`."""
    i = anchor_pos(h, start)
    if i < 0:
        return ""
    j = len(h)
    for e in ends:
        k = anchor_pos(h, e)
        if 0 <= k < j and k > i:
            j = k
    return h[i:j]


# --------------------------------------------------------------------------
# Base size:  "⌀25mm" | "⌀60x35mm" | "⌀32mm flying base"
# --------------------------------------------------------------------------

_RELIC_ROW = re.compile(
    r'(?s)<tr class="">\s*<td class="(wsDataRanged|wsDataMelee)"></td>\s*'
    r'<td class="pad2626"><span>(.*?)</span></td>\s*'
    r'<td><div class="ct pad2626">(.*?)</div></td>\s*'
    r'<td><div class="ct pad2626">(.*?)</div></td>\s*'
    r'<td><div class="ct pad2626">(.*?)</div></td>'
    r'(?:\s*<td[^>]*>(.*?)</td>)?')


def parse_granted_weapons(h: str) -> list[dict]:
    """Weapons handed out by equipment / faction rules render in a
    `table.wTable_relic` with the same cell layout as a datacard, minus the
    long/short duplication. Some have a WR column, some (melee) do not."""
    out: list[dict] = []
    for tbl in re.findall(r'(?s)<table class="wTable_relic".*?</table>', h):
        for m in _RELIC_ROW.finditer(tbl):
            typ, name, atk, hit, dmg, wr = m.groups()
            out.append({
                "type": "ranged" if "Ranged" in typ else "melee",
                "name": inline_text(name), "atk": inline_text(atk),
                "hit": inline_text(hit), "dmg": inline_text(dmg),
                "wr": inline_text(wr or ""),
            })
    return out


_BASE_RE = re.compile(r"(\d+)\s*(?:x|×)\s*(\d+)\s*mm|(\d+)\s*mm", re.I)


def parse_base(raw: str) -> dict | None:
    """-> {'shape':'round','mm':32} | {'shape':'oval','mm':[60,35]} (+ note)."""
    if not raw:
        return None
    txt = raw.replace("⌀", "").strip()
    m = _BASE_RE.search(txt)
    if not m:
        return None
    if m.group(1):
        out: dict = {"shape": "oval", "mm": [int(m.group(1)), int(m.group(2))]}
    else:
        out = {"shape": "round", "mm": int(m.group(3))}
    tail = txt[m.end():].strip(" .")
    if tail:
        out["note"] = tail  # e.g. "flying base"
    return out
