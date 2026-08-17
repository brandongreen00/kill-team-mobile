#!/usr/bin/env python3
"""
Scrape every Warhammer 40,000 Kill Team (3rd ed / KT24) team page from
wahapedia.ru into a raw, faithful JSON dump — one file per team.

    python3 tools/teams/scrape_wahapedia.py            # fetch (uses cache)
    python3 tools/teams/scrape_wahapedia.py --refresh  # ignore cached HTML
    python3 tools/teams/scrape_wahapedia.py --offline  # cache/seed only
    python3 tools/teams/scrape_wahapedia.py --only kasrkin,kommandos

Output
  .cache/wahapedia/html/<slug>.html   cached page (gitignored)
  .cache/wahapedia/raw/<slug>.json    raw structured dump (gitignored)
  .cache/wahapedia/index.json         team index derived from the site nav

Source-of-truth notes
  * The kill-team index page (/kill-team3/kill-teams/) returns 403 to a plain
    client, so the canonical team list is derived from the nav dropdown that is
    embedded in EVERY team page:
        div.NavBtn_Factions + div.NavDropdown-content a[href^="/kill-team3/kill-teams/"]
    The same markup carries the grand faction (div.FactionHeader) and the
    faction group (div.factionGroup_KT), which is where `faction` comes from.
  * A "Mozilla/5.0" UA is required; without it the CDN 403s.

Degradation ladder (so this pipeline always produces output)
  1. network fetch                                        source = "network"
  2. .cache/wahapedia/html/<slug>.html                    source = "cache"
  3. docs/context-pack/research/kill-teams/pages/*.html   source = "seed"
  4. docs/context-pack/research/kill-teams/<slug>.json    source = "context-pack"
     (degraded: the first-pass scrape has no tooltips/books/keyword links; the
      raw dump records `degraded: true` and normalise.py surfaces it in notes)
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wahapedia_html import (  # noqa: E402
    anchor_pos,
    inline_text,
    parse_granted_weapons,
    region,
    strip_chrome,
    text_of,
)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, ".cache", "wahapedia")
HTML_DIR = os.path.join(CACHE, "html")
RAW_DIR = os.path.join(CACHE, "raw")
SEED_DIR = os.path.join(ROOT, "docs", "context-pack", "research", "kill-teams", "pages")
CTXPACK_DIR = os.path.join(ROOT, "docs", "context-pack", "research", "kill-teams")

BASE = "https://wahapedia.ru"
TEAM_URL = BASE + "/kill-team3/kill-teams/{slug}/"
UA = "Mozilla/5.0"
BOOTSTRAP_SLUG = "kasrkin"  # any team page carries the full nav


# ==========================================================================
# fetch
# ==========================================================================


def fetch(url: str, *, tries: int = 4, timeout: int = 30) -> str | None:
    delay = 1.5
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            return raw.decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            code = getattr(e, "code", None)
            if code in (404, 410):
                print(f"    ! {url} -> HTTP {code} (giving up)", file=sys.stderr)
                return None
            if attempt == tries:
                print(f"    ! {url} failed after {tries} tries: {e}", file=sys.stderr)
                return None
            time.sleep(delay + random.random() * 0.5)
            delay *= 2
    return None


def load_html(slug: str, *, offline: bool, refresh: bool) -> tuple[str | None, str]:
    """-> (html, source). Walks the degradation ladder described in the docstring."""
    cached = os.path.join(HTML_DIR, slug + ".html")
    if not refresh and os.path.exists(cached):
        with open(cached, encoding="utf-8", errors="replace") as f:
            return f.read(), "cache"
    if not offline:
        h = fetch(TEAM_URL.format(slug=slug))
        if h and "dsOuterFrame" in h:
            os.makedirs(HTML_DIR, exist_ok=True)
            with open(cached, "w", encoding="utf-8") as f:
                f.write(h)
            return h, "network"
    seed = os.path.join(SEED_DIR, slug + ".html")
    if os.path.exists(seed):
        with open(seed, encoding="utf-8", errors="replace") as f:
            return f.read(), "seed"
    return None, "missing"


# ==========================================================================
# nav dropdown -> team index
# ==========================================================================


def parse_nav(h: str) -> list[dict]:
    i = h.find("NavBtn_Factions")
    if i < 0:
        return []
    j = h.find("NavDropdown-content", i)
    # the dropdown ends where the next top-level NavDropdown begins
    k = h.find('<div class="NavDropdown">', j)
    if k < 0:
        k = h.find("</nav>", j)
    if k < 0:
        k = j + 60000
    seg = h[j:k]
    teams: list[dict] = []
    grand = group = ""
    token = re.compile(
        r'<div class="FactionHeader">(?P<gf>.*?)</div>'
        r'|<div class="factionGroup_KT">(?P<fg>.*?)</div>'
        r'|<a\s+[^>]*href="/kill-team3/kill-teams/(?P<slug>[a-z0-9\-.]+)"[^>]*>(?P<name>.*?)</a>'
    )
    for m in token.finditer(seg):
        if m.group("gf") is not None:
            grand = inline_text(m.group("gf"))
        elif m.group("fg") is not None:
            group = inline_text(m.group("fg"))
        else:
            slug = m.group("slug")
            if any(t["slug"] == slug for t in teams):
                continue
            teams.append({
                "slug": slug,
                "name": inline_text(m.group("name")),
                "grandFaction": grand,
                "faction": group,
                "url": TEAM_URL.format(slug=slug),
            })
    return teams


# ==========================================================================
# page parsers
# ==========================================================================

SECTION_ANCHORS = [
    "Operatives", "Marker-Token-Guide", "Faction-Rules", "Strategy-Ploys",
    "Firefight-Ploys", "Faction-Equipment", "Datacards",
]


def parse_books(h: str) -> tuple[list[dict], str]:
    i = anchor_pos(h, "Books")
    if i < 0:
        return [], ""
    m = re.search(r"(?s)<table\b.*?</table>", h[i:i + 20000])
    if not m:
        return [], ""
    rows: list[dict] = []
    for tr in re.finditer(r"(?s)<tr\b[^>]*>(.*?)</tr>", m.group(0)):
        cells = re.findall(r"(?s)<td\b[^>]*>(.*?)</td>", tr.group(1))
        if len(cells) != 5:
            continue  # group header row (colspan=5) or the <b>Book</b> header
        vals = [inline_text(c) for c in cells]
        if vals[0].lower() == "book":
            continue
        pdf = re.search(r'href="([^"]+\.pdf[^"]*)"', cells[4])
        rows.append({
            "book": vals[0], "kind": vals[1], "edition": vals[2],
            "version": vals[3], "lastUpdate": vals[4],
            "pdf": pdf.group(1) if pdf else None,
        })
    # The team's own faction book is the version we quote. Several team pages
    # leave the Version cell empty and only print a Last update date, so that is
    # the documented fallback.
    ver = ""
    for r in rows:
        if r["kind"].lower() == "faction":
            ver = r["version"] or r["lastUpdate"]
            break
    if not ver and rows:
        ver = rows[0]["version"] or rows[0]["lastUpdate"]
    return rows, ver


def parse_archetypes(h: str) -> tuple[list[str], str]:
    m = re.search(r'(?s)<div class="archetype">(.*?)</div>', h)
    if not m:
        return [], ""
    raw = inline_text(m.group(1))
    links = [inline_text(a) for a in re.findall(r"(?s)<a\b[^>]*>(.*?)</a>", m.group(1))]
    if links:
        return links, raw
    body = re.sub(r"(?i)^archetype:?\s*", "", raw).strip()
    if not body:
        return [], raw
    return [p.strip() for p in body.split("/") if p.strip()], raw


def parse_rule_blocks(seg: str) -> list[dict]:
    """Faction Rules: <a name="Rule"></a><h3>Name</h3><p class=ShowFluff>..</p>text"""
    out: list[dict] = []
    hits = list(re.finditer(r'(?s)<a name="([^"]+)"></a>\s*<h3[^>]*>(.*?)</h3>', seg))
    for n, m in enumerate(hits):
        body = seg[m.end(): hits[n + 1].start() if n + 1 < len(hits) else len(seg)]
        fm = re.search(r'(?s)<p class="ShowFluff legend2">(.*?)</p>', body)
        fluff = text_of(fm.group(1)) if fm else ""
        if fm:
            body = body[:fm.start()] + body[fm.end():]
        out.append({"anchor": m.group(1), "name": inline_text(m.group(2)),
                    "fluff": fluff, "text": text_of(body),
                    "grantedWeapons": parse_granted_weapons(body)})
    return out


def parse_strat_blocks(seg: str, cls: str) -> list[dict]:
    """Ploys / equipment: div.stratName.<cls> > span = NAME, then optional
    fluff <p class="ShowFluff stratLegend2">, then the rules <div>."""
    out: list[dict] = []
    starts = [m for m in re.finditer(
        r'<div class="stratName %s"><span>(.*?)</span></div>' % re.escape(cls), seg, re.S)]
    for n, m in enumerate(starts):
        end = starts[n + 1].start() if n + 1 < len(starts) else len(seg)
        body = seg[m.end():end]
        fm = re.search(r'(?s)<p class="ShowFluff stratLegend2">(.*?)</p>', body)
        fluff = text_of(fm.group(1)) if fm else ""
        rest = body[fm.end():] if fm else body
        # the rules text is the first <div> after the (optional) fluff
        dm = re.search(r"(?s)<div[^>]*>(.*)", rest)
        txt = text_of(dm.group(1)) if dm else text_of(rest)
        # trim anything belonging to the next wrapper / trailing chrome
        out.append({"name": inline_text(m.group(1)), "fluff": fluff, "text": txt,
                    "grantedWeapons": parse_granted_weapons(body)})
    return out


DMG_RE = re.compile(r"^\s*(\S+)\s*/\s*(\S+)\s*$")


def parse_weapons(card_html: str) -> list[dict]:
    weps: list[dict] = []
    row_re = re.compile(
        r'(?s)<tr class="">\s*<td class="wTable2_long"></td>\s*'
        r'<td class="wTable2_short (wsDataRanged|wsDataMelee)"></td>\s*'
        r'<td class="wTable2_short pad2626"><span>(.*?)</span></td>\s*'
        r'<td><div class="ct pad2626">(.*?)</div></td>\s*'
        r'<td><div class="ct pad2626">(.*?)</div></td>\s*'
        r'<td><div class="ct pad2626">(.*?)</div></td>\s*'
        r'(.*?)</tr>')
    for m in row_re.finditer(card_html):
        typ, name, atk, hit, dmg, rest = m.groups()
        wr_m = re.search(r'(?s)<span class="wTable1_short pad2626">(.*?)</span></td>', rest)
        if not wr_m:
            wr_m = re.search(r'(?s)class="wTable1_long pad2626">(.*?)</td>', rest)
        wr_html = wr_m.group(1) if wr_m else ""
        weps.append({
            "type": "ranged" if "Ranged" in typ else "melee",
            "name": inline_text(name),
            "atk": inline_text(atk),
            "hit": inline_text(hit),
            "dmg": inline_text(dmg),
            "wr": inline_text(wr_html),
            "wrTooltips": sorted(set(re.findall(r'data-tooltip-content="#(tooltip_content[^"]+)"', wr_html))),
        })
    return weps


ACTION_HDR = re.compile(r'(?s)<h3 class="h_actions_ds">(.*?)<span>(.*?)</span></h3>')


MARKER_RE = re.compile(r"^\s*(\*+|\^\d+)\s*")


def split_marker(name: str) -> tuple[str, str]:
    """'*Shield' -> ('*', 'Shield');  '^1Twin Torrent' -> ('^1', 'Twin Torrent')."""
    m = MARKER_RE.match(name)
    return (m.group(1), name[m.end():].strip()) if m else ("", name.strip())


def parse_abilities_actions(card_html: str) -> tuple[list[dict], list[dict], list[dict]]:
    """-> (abilities, unique actions, footnote notes).

    The abilities/actions column is a `div.wtOuterFrame` AFTER the weapon
    table's own wtOuterFrame. Three printed forms are handled:
      * `<span class="redfont">Name</span><b>: </b>text`     (the usual one)
      * `*<b>Skytorch:</b> text`                              (Vespid Swarmguard)
      * `<h3 class="h_actions_ds">NAME<span>1AP</span></h3>`  (unique actions)
    A block that is none of these but opens with a footnote marker is a
    footnote NOTE (`*Note that Torrent 0" means ...`), kept separately."""
    end = card_html.find('<table class="dsKeywords"')
    if end < 0:
        end = len(card_html)
    seg = ""
    for m in re.finditer(r'<div class="wtOuterFrame[^"]*">', card_html):
        if m.start() >= end:
            break
        if 'class="wTable"' in card_html[m.end():m.end() + 600]:
            continue
        seg = card_html[m.end():end]
        break
    if not seg:
        return [], [], []

    abilities: list[dict] = []
    actions: list[dict] = []
    footnotes: list[dict] = []

    blocks = re.split(r'(?=<div class="BreakInsideAvoid"[^>]*style="padding:2px 6px 10px 6px">)', seg)
    for b in blocks:
        if not b.strip():
            continue
        # --- unique actions -------------------------------------------------
        hits = list(ACTION_HDR.finditer(b))
        for n, hm in enumerate(hits):
            after = b[hm.end(): hits[n + 1].start() if n + 1 < len(hits) else len(b)]
            eff = [text_of(x) for x in re.findall(r'(?s)<div class="actionEffect">(.*?)</div>', after)]
            cond = [text_of(x) for x in re.findall(r'(?s)<div class="actionConditions">(.*?)</div>', after)]
            kws = [inline_text(k) for k in re.findall(r'(?s)<span class="kwb[^"]*">(.*?)</span>', hm.group(1))]
            actions.append({
                "name": inline_text(hm.group(1)),
                "cost": inline_text(hm.group(2)),
                "keywords": [k for k in kws if k],
                "effect": eff, "conditions": cond, "text": text_of(after),
            })
        head = b[: hits[0].start()] if hits else b

        # --- redfont abilities ----------------------------------------------
        found = False
        for am in re.finditer(r'(?s)<span class="redfont">(.*?)</span><b>:\s*</b>(.*?)'
                              r'(?=<span class="redfont">|<div class="a_indent">|$)', head):
            marker, nm = split_marker(inline_text(am.group(1)))
            abilities.append({"name": nm, "marker": marker, "text": text_of(am.group(2))})
            found = True
        if found:
            continue

        # --- bold-name abilities --------------------------------------------
        bm = re.match(r'(?s)\s*(?:<div[^>]*>\s*)*'
                      r'(?:<span class="ast">(\*+)</span>|<sup\b[^>]*>\s*(?:<b>)?(\d+)(?:</b>)?\s*</sup>)?'
                      r'\s*<b>\s*([^<:]{2,60}?)\s*:?\s*</b>\s*:?\s*(.*)$', head)
        if bm and bm.group(3) and len(text_of(bm.group(4))) > 20:
            marker = bm.group(1) or ("^" + bm.group(2) if bm.group(2) else "")
            abilities.append({"name": bm.group(3).strip(), "marker": marker,
                              "text": text_of(bm.group(4))})
            continue

        # --- footnote notes ---------------------------------------------------
        if not hits:
            txt = text_of(head)
            if txt:
                marker, body = split_marker(txt)
                if marker:
                    footnotes.append({"marker": marker, "text": body})
    return abilities, actions, footnotes


def parse_datacards(h: str) -> list[dict]:
    starts = list(re.finditer(r'(?s)<a name="([^"]+)"></a>\s*<div class="pagebreak"[^>]*>\s*<div class="dsOuterFrame">', h))
    cards: list[dict] = []
    for n, m in enumerate(starts):
        end = starts[n + 1].start() if n + 1 < len(starts) else len(h)
        body = h[m.start():end]
        tt = body.find('<div class="tooltip_templates">')
        if tt >= 0:
            body = body[:tt]
        nm = re.search(r'(?s)<h3 class="pTable_h3"><div>(.*?)(?:<a\b|</div>)', body)
        fm = re.search(r'(?s)<p class="ShowFluff legend2">(.*?)</p>', body)
        stats = {k: inline_text(v) for k, v in re.findall(
            r'(?s)<td class="pCell[^"]*">(\w+)<div class="dsStat"><img[^>]*>(.*?)</div>', body)}
        bm = re.search(r'(?s)<td[^>]*class="ShowBaseSize"[^>]*>(.*?)</td>', body)
        km = re.search(r'(?s)<span class="dsKeywordData">(.*?)</div>\s*</td>', body)
        kw_html = km.group(1) if km else ""
        keywords = [k.strip() for k in inline_text(kw_html).split(",") if k.strip()]
        faction_kw = [inline_text(x) for x in re.findall(
            r'(?s)<span class="(?:inb )?fkwb[^"]*">(.*?)</span>', kw_html)]
        abilities, actions, footnotes = parse_abilities_actions(body)
        cards.append({
            "anchor": m.group(1),
            "name": inline_text(nm.group(1)) if nm else "",
            "fluff": text_of(fm.group(1)) if fm else "",
            "stats": stats,
            "baseRaw": inline_text(bm.group(1)) if bm else "",
            "keywords": keywords,
            "factionKeywords": [k for k in faction_kw if k],
            "weapons": parse_weapons(body),
            "abilities": abilities,
            "actions": actions,
            "footnotes": footnotes,
        })
    return cards


def parse_tooltips(h: str) -> dict[str, dict]:
    """div.tooltip_templates > span#tooltip_contentNNNN — the glossary that
    defines rare weapon rules and keywords."""
    out: dict[str, dict] = {}
    chunks = re.split(r'<div class="tooltip_templates">', h)[1:]
    for c in chunks:
        m = re.match(r'(?s)\s*<span id="([^"]+)">(.*)', c)
        if not m:
            continue
        tid, body = m.group(1), m.group(2)
        nxt = body.find('<div class="tooltip_templates">')
        if nxt >= 0:
            body = body[:nxt]
        body = re.sub(r"(?s)</span>\s*</div>\s*$", "", body.rstrip())
        hm = re.search(r'(?s)<div class="tooltip_header">(.*?)</div>', body)
        if hm:
            title = inline_text(hm.group(1))
            text = text_of(body[hm.end():])
            kind = "term"
        else:
            am = re.search(r'(?s)<h2 class="h_actions_ds"><span>(.*?)(?:<a\b|</span>)', body)
            if not am:
                continue
            title = inline_text(am.group(1))
            text = text_of(body[am.end():])
            kind = "action"
        out[tid] = {"id": tid, "title": title, "text": text, "kind": kind}
    return out


def parse_selection(h: str) -> dict:
    seg = region(h, "Operatives", ["Marker-Token-Guide", "Faction-Rules"])
    if not seg:
        return {"html": "", "text": ""}
    seg = re.sub(r'(?s)^<a name="Operatives"></a>\s*<h2[^>]*>.*?</h2>', "", seg)
    cut = seg.find("<div ><br></div></div>")
    if cut >= 0:
        seg = seg[:cut]
    seg = strip_chrome(seg)
    # `div.Corner25` is the designer's note box ("Some KASRKIN rules refer to a
    # 'hot-shot weapon'..."). It is commentary, not a selection constraint.
    notes = [text_of(m) for m in re.findall(r'(?s)<div class="Corner25">(.*?)</div>', seg)]
    seg = re.sub(r'(?s)<div class="Corner25">.*?</div>', " ", seg)
    seg = re.sub(r'(?s)<div class="noprint page_breaker_ads">.*?$', " ", seg)
    return {"html": seg.strip(), "text": text_of(seg),
            "designerNotes": [n for n in notes if n]}


def parse_marker_guide(h: str) -> str:
    seg = region(h, "Marker-Token-Guide", ["Faction-Rules", "Strategy-Ploys"])
    seg = re.sub(r'(?s)^<a name="[^"]+"></a>\s*<h2[^>]*>.*?</h2>', "", seg)
    return text_of(seg)


def parse_page(slug: str, h: str, meta: dict, source: str) -> dict:
    books, ver = parse_books(h)
    archetypes, arch_raw = parse_archetypes(h)
    fr_seg = region(h, "Faction-Rules", ["Strategy-Ploys"])
    ploy_seg = region(h, "Strategy-Ploys", ["Datacards"])
    h1 = re.search(r"(?s)<h1[^>]*>(.*?)</h1>", h)
    return {
        "slug": slug,
        "name": meta.get("name") or (inline_text(h1.group(1)) if h1 else slug),
        "faction": meta.get("faction", ""),
        "grandFaction": meta.get("grandFaction", ""),
        "sourceUrl": TEAM_URL.format(slug=slug),
        "scrapedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "degraded": False,
        "books": books,
        "booksVersion": ver,
        "archetypes": archetypes,
        "archetypeRaw": arch_raw,
        "selection": parse_selection(h),
        "markerGuide": parse_marker_guide(h),
        "factionRules": parse_rule_blocks(fr_seg),
        "strategyPloys": parse_strat_blocks(ploy_seg, "stratStrategicPloy"),
        "firefightPloys": parse_strat_blocks(ploy_seg, "stratTacticalPloy"),
        "equipment": parse_strat_blocks(ploy_seg, "stratEquipment"),
        "datacards": parse_datacards(h),
        "tooltips": parse_tooltips(h),
    }


# ==========================================================================
# last-resort: the first-pass context-pack JSON
# ==========================================================================


def from_context_pack(slug: str, meta: dict) -> dict | None:
    p = os.path.join(CTXPACK_DIR, slug + ".json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        d = json.load(f)
    arch = (d.get("archetype") or "").replace("Archetype:", "").strip()
    cards = []
    for c in d.get("datacards", []):
        cards.append({
            "anchor": c.get("anchor", ""), "name": c.get("name", ""),
            "fluff": c.get("fluff", ""), "stats": c.get("stats", {}),
            "baseRaw": c.get("base", ""), "keywords": c.get("keywords", []),
            "factionKeywords": [],
            "weapons": [{**w, "wrTooltips": []} for w in c.get("weapons", [])],
            "abilities": [{**a, "marker": ""} for a in c.get("abilities", [])],
            "footnotes": [],
            "actions": [{"name": a.get("name", ""), "cost": a.get("cost", ""),
                         "keywords": [], "effect": [a.get("effect", "")],
                         "conditions": [a.get("conditions", "")],
                         "text": "\n".join(x for x in [a.get("effect", ""), a.get("conditions", "")] if x)}
                        for a in c.get("actions", [])],
        })
    return {
        "slug": slug, "name": meta.get("name", slug), "faction": meta.get("faction", ""),
        "grandFaction": meta.get("grandFaction", ""),
        "sourceUrl": TEAM_URL.format(slug=slug),
        "scrapedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "context-pack", "degraded": True,
        "books": [], "booksVersion": "",
        "archetypes": [p.strip() for p in arch.split("/") if p.strip()],
        "archetypeRaw": d.get("archetype") or "",
        "selection": {"html": d.get("operatives_selection_html") or "",
                      "text": d.get("operatives_selection_text") or "",
                      "designerNotes": []},
        "markerGuide": "",
        "factionRules": [{**r, "anchor": "", "fluff": ""} for r in d.get("faction_rules", [])],
        "strategyPloys": d.get("strategy_ploys", []),
        "firefightPloys": d.get("firefight_ploys", []),
        "equipment": d.get("equipment", []),
        "datacards": cards, "tooltips": {},
    }


# ==========================================================================


def load_index(offline: bool, refresh: bool) -> list[dict]:
    idx_path = os.path.join(CACHE, "index.json")
    h, _ = load_html(BOOTSTRAP_SLUG, offline=offline, refresh=refresh)
    teams = parse_nav(h) if h else []
    if not teams and os.path.exists(idx_path):
        with open(idx_path, encoding="utf-8") as f:
            teams = json.load(f)
    if not teams:  # final fallback: the researched list
        lm = os.path.join(CTXPACK_DIR, "list.md")
        if os.path.exists(lm):
            with open(lm, encoding="utf-8") as f:
                for line in f:
                    c = [x.strip() for x in line.strip().strip("|").split("|")]
                    if len(c) == 6 and c[0].isdigit():
                        teams.append({"slug": c[4], "name": c[3], "grandFaction": c[1],
                                      "faction": c[2], "url": c[5]})
    if teams:
        os.makedirs(CACHE, exist_ok=True)
        with open(idx_path, "w", encoding="utf-8") as f:
            json.dump(teams, f, indent=1, ensure_ascii=False)
    return teams


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="never touch the network")
    ap.add_argument("--refresh", action="store_true", help="ignore cached HTML, refetch")
    ap.add_argument("--only", default="", help="comma-separated slugs")
    ap.add_argument("--delay", type=float, default=0.7, help="politeness delay between fetches")
    args = ap.parse_args()

    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(HTML_DIR, exist_ok=True)

    teams = load_index(args.offline, args.refresh)
    if not teams:
        print("FATAL: could not derive the team list (no network, no cache, no list.md)", file=sys.stderr)
        return 2
    print(f"team index: {len(teams)} teams")

    wanted = {s.strip() for s in args.only.split(",") if s.strip()}
    if wanted:
        teams = [t for t in teams if t["slug"] in wanted]

    ok = 0
    stats: dict[str, int] = {}
    for t in teams:
        slug = t["slug"]
        h, src = load_html(slug, offline=args.offline, refresh=args.refresh)
        if h:
            raw = parse_page(slug, h, t, src)
            if not raw["datacards"]:
                alt = from_context_pack(slug, t)
                if alt:
                    raw, src = alt, "context-pack"
        else:
            raw = from_context_pack(slug, t)
            src = "context-pack" if raw else "missing"
            if raw is None:
                print(f"  !! {slug}: no HTML and no context-pack fallback", file=sys.stderr)
                continue
        stats[src] = stats.get(src, 0) + 1
        with open(os.path.join(RAW_DIR, slug + ".json"), "w", encoding="utf-8") as f:
            json.dump(raw, f, indent=1, ensure_ascii=False)
        ok += 1
        print(f"  {slug:28s} {src:12s} cards={len(raw['datacards']):2d} "
              f"SP={len(raw['strategyPloys'])} FP={len(raw['firefightPloys'])} "
              f"EQ={len(raw['equipment'])} FR={len(raw['factionRules'])} "
              f"tt={len(raw['tooltips'])}")
        if src == "network" and args.delay:
            time.sleep(args.delay)

    print(f"\nwrote {ok}/{len(teams)} raw dumps to {os.path.relpath(RAW_DIR, ROOT)}")
    print("sources: " + ", ".join(f"{k}={v}" for k, v in sorted(stats.items())))
    return 0 if ok == len(teams) else 1


if __name__ == "__main__":
    raise SystemExit(main())
