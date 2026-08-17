#!/usr/bin/env python3
"""
Terrain piece catalogue for the four Approved Ops 2025 killzones.

Two things live here:

  * `PIECES` — for every piece kind, the parts it is made of, with each part's
    terrain types (verbatim from the Killzones rules page), role, and elevation.
  * `HEIGHTS` — every elevation used above, with `provenance` and `confidence`.

Rule of the project: a measured height is never rounded to a rules threshold.
Where a value lands within 0.25" of 1"/2"/3"/4" that is called out in
docs/MAPS.md rather than being snapped.

Terrain-type sources (docs/context-pack/research/core-rules/killzones.txt):
  Volkus Stronghold      §"Stronghold" A-H
  Volkus Large Ruin      §"Large Ruin" A-E
  Volkus Small Ruin      §"Small Ruin"      -> Heavy
  Volkus Heavy Rubble    §"Heavy Rubble"    -> Heavy
  Volkus Light Rubble    §"Light Rubble"    -> Light
  Gallowdark / Tomb World walls, hatchways, breach points, teleport pad, light terrain
  Bheta-Decima gantry + thermometric condenser
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# Heights, in inches. `id -> (value, confidence, provenance)`
# ---------------------------------------------------------------------------
HEIGHTS: dict[str, tuple[float, str, str]] = {
    # --- Volkus -----------------------------------------------------------
    'volkus.strongholdA.top': (
        5.906, 'community',
        'Tale of Painters, "Review: Kill Team: Hivestorm Pt.1" (2024-09): Stronghold A '
        '(promethium-tank build) "footprint of approx. 18 x 13 cm, with a max. height of '
        '15 cm" -> 150mm / 25.4'),
    'volkus.strongholdA.level1': (
        3.0, 'community',
        'Tale of Painters, Hivestorm review: Stronghold A has "a floor at 3″ height"'),
    'volkus.strongholdB.top': (
        7.480, 'community',
        'Tale of Painters, Hivestorm review: Stronghold B "footprint of approx. 19 x 19cm, '
        'a maximum height of 19 cm" -> 190mm / 25.4'),
    'volkus.strongholdB.level1': (
        3.0, 'community',
        'Tale of Painters, Hivestorm review: Stronghold B "floors placed at 3″ and 6″ height"'),
    'volkus.strongholdB.level2': (
        6.0, 'community',
        'Tale of Painters, Hivestorm review: Stronghold B "floors placed at 3″ and 6″ height"'),
    'volkus.largeRuin.level1': (
        3.5, 'community',
        'Tale of Painters, Hivestorm review: Manufactorum Ruins have "a top floor (placed at '
        '3.5″ from the bottom)". Killzones rules: for intervening and targeting lines this '
        'level is TREATED as the height of a stronghold’s first upper level (3.0") — '
        'see `treatAsZ`.'),
    'volkus.largeRuin.top': (
        4.5, 'assumed',
        'No published figure. Upper rampart modelled as 1" of Light parapet above the 3.5" '
        'floor. CONFIRM WITH OWNER.'),
    'volkus.smallRuin.top': (
        2.0, 'assumed',
        'No published figure; the small ruin is a low corner wall roughly two thirds the '
        'height of a stronghold’s first floor. CONFIRM WITH OWNER.'),
    'volkus.heavyRubble.top': (
        1.5, 'assumed',
        'No published figure. Heavy rubble is modelled taller than a 32mm base is wide but '
        'below the 2" jump/drop threshold. CONFIRM WITH OWNER.'),
    'volkus.lightRubble.top': (
        1.0, 'assumed',
        'No published figure. CONFIRM WITH OWNER.'),
    'volkus.wreckage.top': (
        1.25, 'assumed',
        'Piece L (long wreckage) is not in the core-book Volkus inventory and has no '
        'published rules entry. CONFIRM WITH OWNER.'),
    'volkus.crates.top': (
        1.5, 'assumed',
        'Piece N (cargo-crate stack) is not in the core-book Volkus inventory and has no '
        'published rules entry. CONFIRM WITH OWNER.'),

    # --- Gallowdark / Tomb World -----------------------------------------
    'cq.wall.top': (
        2.362, 'community',
        'Tale of Painters, "Review: Kill Team: Into the Dark – Part 1" (2022-09): '
        '"the Gallowdark elements have a height of 6 cm" -> 60mm / 25.4. Wall terrain blocks '
        'movement and visibility by rule regardless of height.'),
    'cq.wall.double': (
        4.724, 'community',
        'Tale of Painters, Into the Dark review: "Two Gallowdark elements have a height of 12 cm".'),
    'cq.teleportPad.top': (
        0.2, 'photogrammetry',
        'Measured off keys/TW3.jpg (teleport pad product photo) against its own 3.8125" '
        'square footprint: the pad is a shallow disc, ~5% of its width. It is Insignificant '
        'terrain, so the exact value never affects climb/drop.'),
    'cq.light.top': (
        1.2, 'assumed',
        'Sarcophagus / debris are Light terrain; no published height. CONFIRM WITH OWNER.'),

    # --- Bheta-Decima -----------------------------------------------------
    'bheta.gantry.deck': (
        3.0, 'assumed',
        'NO published measurement found for the Bheta-Decima gantries (checked GW product '
        'pages, Tale of Painters and Goonhammer reviews, and the Kerlin killzone PDF). 3.0" '
        'is chosen because it matches the Volkus stronghold first floor, keeps the deck '
        'inside the 3" climb reach from the killzone floor, and above the 2" free-drop '
        'threshold. HIGHEST-PRIORITY VALUE TO CONFIRM WITH OWNER.'),
    'bheta.condenser.roof': (
        3.0, 'assumed',
        'No published measurement. Set equal to the gantry deck so the roof and adjoining '
        'gantries read as one level. CONFIRM WITH OWNER.'),
    'bheta.condenser.ledge': (
        2.75, 'assumed',
        'The inner ledge is Exposed + Insignificant, i.e. the rules explicitly say to ignore '
        'the slight height difference, so this value is cosmetic. CONFIRM WITH OWNER.'),
    'bheta.condenser.battlement': (
        3.75, 'assumed',
        'Battlements modelled as 0.75" of Light parapet above the roof. CONFIRM WITH OWNER.'),
}


def h(key: str) -> float:
    return HEIGHTS[key][0]


# ---------------------------------------------------------------------------
# Piece catalogue.  Each entry:
#   label      the letter printed on the map cards
#   name       human name
#   parts      list of dicts describing every part the cards can place
#              (`from` selects which traced primitive supplies the polygon)
#   notes      parts the rules define but the cards do not draw
# ---------------------------------------------------------------------------
PIECES: dict[str, dict] = {
    # ---------------- Volkus ----------------
    'volkus.strongholdA': dict(
        killzone='volkus', labels=['A'], name='Stronghold A', count=1,
        parts=[
            dict(role='wall', from_='ink', types=['Heavy'], z0=0.0, z1=h('volkus.strongholdA.top'),
                 blocksVisibility=True, solid=True, standable=False),
            dict(role='door', from_='door', types=['Accessible', 'Heavy'], z0=0.0,
                 z1=h('volkus.strongholdA.top'), blocksVisibility=True, solid=False,
                 standable=False),
            dict(role='floor', from_='green', types=['Ceiling', 'Vantage', 'Light'],
                 z0=h('volkus.strongholdA.level1'), z1=h('volkus.strongholdA.level1'),
                 blocksVisibility=True, standable=True, solid=False),
        ],
        notes=[
            'Rules parts the map cards do not draw, so they are not in the extracted geometry: '
            'the broken vent (Blocking), the three barrel containers (Blocking + Heavy), the '
            'small broken ramparts on the Vantage edge (Insignificant + Exposed) and the fire '
            'steps (Vantage + Insignificant + Exposed).',
            'For control range, ignore the door and any part under 2" high when determining '
            'visibility (Killzones §Stronghold).',
        ]),
    'volkus.strongholdB': dict(
        killzone='volkus', labels=['B'], name='Stronghold B', count=1,
        parts=[
            dict(role='wall', from_='ink', types=['Heavy'], z0=0.0, z1=h('volkus.strongholdB.top'),
                 blocksVisibility=True, solid=True, standable=False),
            dict(role='door', from_='door', types=['Accessible', 'Heavy'], z0=0.0,
                 z1=h('volkus.strongholdB.top'), blocksVisibility=True, solid=False,
                 standable=False),
            dict(role='floor', from_='green', types=['Ceiling', 'Vantage', 'Light'],
                 z0=h('volkus.strongholdB.level1'), z1=h('volkus.strongholdB.level1'),
                 blocksVisibility=True, standable=True, solid=False),
            dict(role='floor', from_='darkgreen', types=['Ceiling', 'Vantage', 'Light'],
                 z0=h('volkus.strongholdB.level2'), z1=h('volkus.strongholdB.level2'),
                 blocksVisibility=True, standable=True, solid=False, maxOperatives=1),
        ],
        notes=[
            'The gap on the lower Vantage level is Accessible terrain; the cards do not mark '
            'where it is.',
            'At most one friendly operative may be on the highest upper level at a time, and '
            'it must be placed to one side, not in the middle (Killzones §Stronghold H) — '
            'carried as `maxOperatives: 1` on that part.',
        ]),
    'volkus.largeRuin': dict(
        killzone='volkus', labels=['C', 'D'], name='Large Ruin', count=2,
        parts=[
            dict(role='wall', from_='ink', types=['Heavy'], z0=0.0,
                 z1=h('volkus.largeRuin.level1'), blocksVisibility=True, solid=True,
                 standable=False),
            dict(role='door', from_='door', types=['Accessible', 'Heavy'], z0=0.0,
                 z1=h('volkus.largeRuin.level1'), blocksVisibility=True, solid=False,
                 standable=False),
            dict(role='floor', from_='green', types=['Ceiling', 'Vantage', 'Light'],
                 z0=h('volkus.largeRuin.level1'), z1=h('volkus.largeRuin.level1'),
                 blocksVisibility=True, standable=True, solid=False, treatAsZ=3.0),
            dict(role='rampart', from_='green_edge', types=['Light'],
                 z0=h('volkus.largeRuin.level1'), z1=h('volkus.largeRuin.top'),
                 blocksVisibility=False, standable=False, solid=False, optional=True),
        ],
        notes=[
            'For intervening and targeting lines the upper level counts as the same height as '
            'a stronghold’s first upper level (3.0") — carried as `treatAsZ`.',
            'The door’s viewpoint is Blocking and unbroken windows are Barred + Heavy; the '
            'cards do not draw either.',
        ]),
    'volkus.smallRuin': dict(
        killzone='volkus', labels=['E', 'F'], name='Small Ruin', count=2,
        parts=[dict(role='wall', from_='ink', types=['Heavy'], z0=0.0,
                    z1=h('volkus.smallRuin.top'), blocksVisibility=True, solid=True,
                    standable=False)],
        notes=['Killzones §Small Ruin: "This is Heavy terrain."']),
    'volkus.heavyRubble': dict(
        killzone='volkus', labels=['G', 'H'], name='Heavy Rubble', count=2,
        parts=[dict(role='rubble', from_='green', types=['Heavy'], z0=0.0,
                    z1=h('volkus.heavyRubble.top'), blocksVisibility=True, solid=True,
                    standable=False)],
        notes=['Killzones §Heavy Rubble: "This is Heavy terrain."']),
    'volkus.lightRubble': dict(
        killzone='volkus', labels=['I', 'J', 'K'], name='Light Rubble', count=3,
        parts=[dict(role='rubble', from_='green', types=['Light'], z0=0.0,
                    z1=h('volkus.lightRubble.top'), blocksVisibility=False, solid=True,
                    standable=False)],
        notes=['Killzones §Light Rubble: "This is Light terrain."']),
    'volkus.wreckage': dict(
        killzone='volkus', labels=['L'], name='Wreckage', count=1,
        parts=[dict(role='rubble', from_='green', types=['Light'], z0=0.0,
                    z1=h('volkus.wreckage.top'), blocksVisibility=False, solid=True,
                    standable=False)],
        notes=['Not in the core-book Volkus inventory (2x stronghold, 2x large ruin, 2x small '
               'ruin, 2x heavy rubble, 3x light rubble); shown on keys/VS1.png. Terrain type '
               'ASSUMED Light. CONFIRM WITH OWNER.']),
    'volkus.beamRubble': dict(
        killzone='volkus', labels=['M'], name='Rubble with Beams', count=1,
        parts=[dict(role='rubble', from_='green', types=['Light'], z0=0.0,
                    z1=h('volkus.lightRubble.top'), blocksVisibility=False, solid=True,
                    standable=False)],
        notes=['Not in the core-book Volkus inventory; shown on keys/VS1.png. Terrain type '
               'ASSUMED Light. CONFIRM WITH OWNER.']),
    'volkus.crates': dict(
        killzone='volkus', labels=['N'], name='Cargo Crates', count=1,
        parts=[dict(role='crate', from_='green', types=['Heavy'], z0=0.0,
                    z1=h('volkus.crates.top'), blocksVisibility=True, solid=True,
                    standable=False)],
        notes=['Not in the core-book Volkus inventory; shown on keys/VS1.png as a stack of '
               'shipping crates. Terrain type ASSUMED Heavy. CONFIRM WITH OWNER.']),

    # ---------------- Bheta-Decima ----------------
    'bheta.gantryShort': dict(
        killzone='bheta-decima', labels=['A'], name='Short Gantry', count=2,
        parts=[dict(role='floor', from_='green', types=['Accessible', 'Vantage', 'Light'],
                    z0=h('bheta.gantry.deck'), z1=h('bheta.gantry.deck'),
                    blocksVisibility=True, standable=True, solid=False)],
        notes=['Gantry floors are Accessible and Vantage terrain; gantry pillars are Heavy. '
               'The cards draw only the deck footprint, so pillars are not extracted.',
               'Connected gantries (decks touching) are treated as the same terrain — '
               'carried as a shared `groupId`.']),
    'bheta.gantryMedium': dict(
        killzone='bheta-decima', labels=['B'], name='Medium Gantry', count=4,
        parts=[dict(role='floor', from_='green', types=['Accessible', 'Vantage', 'Light'],
                    z0=h('bheta.gantry.deck'), z1=h('bheta.gantry.deck'),
                    blocksVisibility=True, standable=True, solid=False)]),
    'bheta.gantryLong': dict(
        killzone='bheta-decima', labels=['C'], name='Long Gantry', count=2,
        parts=[dict(role='floor', from_='green', types=['Accessible', 'Vantage', 'Light'],
                    z0=h('bheta.gantry.deck'), z1=h('bheta.gantry.deck'),
                    blocksVisibility=True, standable=True, solid=False)]),
    'bheta.condenser': dict(
        killzone='bheta-decima', labels=['D'], name='Thermometric Condenser', count=1,
        parts=[
            dict(role='wall', from_='green', types=['Heavy'], z0=0.0,
                 z1=h('bheta.condenser.roof'), blocksVisibility=True, solid=True,
                 standable=False),
            dict(role='floor', from_='green', types=['Accessible', 'Vantage', 'Light'],
                 z0=h('bheta.condenser.roof'), z1=h('bheta.condenser.roof'),
                 blocksVisibility=True, standable=True, solid=False),
            dict(role='ledge', from_='green_inner', types=['Exposed', 'Insignificant'],
                 z0=h('bheta.condenser.ledge'), z1=h('bheta.condenser.roof'),
                 blocksVisibility=False, standable=True, solid=False, optional=True),
            dict(role='rampart', from_='green_edge', types=['Light'],
                 z0=h('bheta.condenser.roof'), z1=h('bheta.condenser.battlement'),
                 blocksVisibility=False, standable=False, solid=False, optional=True),
        ],
        notes=['Killzones §Thermometric Condenser: roof Accessible + Vantage, inner ledge '
               'Exposed + Insignificant, battlements Light, everything else Heavy.']),

    # ---------------- Gallowdark ----------------
    'gallowdark.wallA1': dict(killzone='gallowdark', labels=['A1'], name='Long Wall', count=2,
                              span=2, hatch=False, pillars=False),
    'gallowdark.wallA2': dict(killzone='gallowdark', labels=['A2'], name='Long Wall with Pillars',
                              count=2, span=2, hatch=False, pillars=True),
    'gallowdark.wallA3': dict(killzone='gallowdark', labels=['A3'], name='Long Wall with Hatchway',
                              count=2, span=2, hatch=True, pillars=False),
    'gallowdark.wallA4': dict(killzone='gallowdark', labels=['A4'],
                              name='Long Wall with Hatchway and Pillars', count=2, span=2,
                              hatch=True, pillars=True),
    'gallowdark.wallB1': dict(killzone='gallowdark', labels=['B1'], name='Short Wall', count=2,
                              span=1, hatch=False, pillars=False),
    'gallowdark.wallB2': dict(killzone='gallowdark', labels=['B2'],
                              name='Short Wall with Hatchway', count=2, span=1, hatch=True,
                              pillars=False),
    'gallowdark.wallB3': dict(killzone='gallowdark', labels=['B3'],
                              name='Short Wall with Hatchway and Pillars', count=4, span=1,
                              hatch=True, pillars=True),

    # ---------------- Tomb World ----------------
    'tomb-world.wallA1': dict(killzone='tomb-world', labels=['A1'],
                              name='Long Wall with Breach Point', count=2, span=2, breach=True),
    'tomb-world.wallA2': dict(killzone='tomb-world', labels=['A2'], name='Long Wall with Pillars',
                              count=2, span=2, pillars=True),
    'tomb-world.wallA3': dict(killzone='tomb-world', labels=['A3'], name='Long Wall with Hatchway',
                              count=2, span=2, hatch=True),
    'tomb-world.wallA4': dict(killzone='tomb-world', labels=['A4'],
                              name='Long Wall with Hatchway and Pillars', count=2, span=2,
                              hatch=True, pillars=True),
    'tomb-world.wallB1': dict(killzone='tomb-world', labels=['B1'], name='Short Wall', count=2,
                              span=1),
    'tomb-world.wallB2': dict(killzone='tomb-world', labels=['B2'],
                              name='Short Wall with Breach Point', count=2, span=1, breach=True),
    'tomb-world.wallB3': dict(killzone='tomb-world', labels=['B3'],
                              name='Short Wall with Hatchway and Pillars', count=2, span=1,
                              hatch=True, pillars=True),
    'tomb-world.wallB4': dict(killzone='tomb-world', labels=['B4'], name='Short Wall with Pillars',
                              count=2, span=1, pillars=True),
    'tomb-world.sarcophagus': dict(killzone='tomb-world', labels=['C1'], name='Sarcophagus',
                                   count=1, light=True),
    'tomb-world.debris': dict(killzone='tomb-world', labels=['C2', 'C3', 'C4', 'C5'],
                              name='Debris', count=4, light=True),
    'tomb-world.teleportPad': dict(killzone='tomb-world', labels=['T'], name='Teleport Pad',
                                   count=2, pad=True),
}

# Close-quarters part templates (shared by both CQ killzones).
CQ_WALL_TYPES = ['Heavy', 'Wall']
CQ_ACCESS_CLOSED = ['Heavy', 'Wall']
CQ_ACCESS_OPEN = ['Accessible', 'Insignificant', 'Exposed']
CQ_PAD_TYPES = ['Exposed', 'Insignificant', 'Vantage']
CQ_LIGHT_TYPES = ['Light']

LABEL_TO_KIND: dict[tuple[str, str], str] = {}
for _k, _v in PIECES.items():
    for _lab in _v['labels']:
        LABEL_TO_KIND[(_v['killzone'], _lab)] = _k
