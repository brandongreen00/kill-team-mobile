# tools/maps — Approved Ops 2025 killzone map extraction

Turns the 24 official Approved Ops 2025 **map cards** (PNG) into

* `data/maps/<killzone>/<killzone>-N.json` — one `KillzoneMap` per card
  (`src/core/types.ts` is the authority on the shape), and
* `data/terrain/<killzone>.json` — the terrain piece catalogue: local-space
  footprints, part typing, and every elevation with `provenance` + `confidence`.

Nothing is hand-traced. Every polygon comes from a colour mask on the card, so
the whole of `data/maps/**` is reproducible from the committed PNGs.

## Commands

```bash
pnpm maps:extract       # python3 tools/maps/extract_cards.py            (~6 min)
pnpm maps:overlay       # python3 tools/maps/render_overlay.py           (~30 s)
pnpm maps:validate      # python3 tools/maps/validate_maps.py            (~2 min)
pnpm maps:test          # python3 tools/maps/test_extract.py             (~5 s)

python3 tools/maps/extract_cards.py volkus-1 gallowdark-3   # a subset
python3 tools/maps/validate_maps.py --json                  # machine readable
python3 tools/maps/labels.py --dump                         # unmapped OCR glyphs
```

Dependencies: `numpy`, `scipy`, `scikit-image`, `Pillow`. Build-time only — the
app never fetches or computes any of this at runtime.

## Inputs

| Path | What |
| --- | --- |
| `docs/context-pack/research/approved-ops/maps/*.png` | the 24 map cards (`Non-specific*.png` are out of scope) |
| `docs/context-pack/research/approved-ops/keys/*` | legend swatches (exact palette RGB) and the killzone terrain keys |
| `docs/context-pack/research/core-rules/killzones.txt` | verbatim terrain-type rules, transcribed into `terrain.py` |

The card for Bheta-Decima map 5 is named `Bheta-Decima2025-55.png`; it is
extracted as `bheta-decima-5`.

## Modules

| File | Role |
| --- | --- |
| `cardlib.py` | palette, board calibration (`Frame`), contour tracing, Douglas-Peucker, IoU |
| `labels.py` | label-chip detection + exact-bitmap glyph OCR |
| `geom.py` | rectangle decomposition, blob splitting, transforms |
| `terrain.py` | the piece catalogue: parts, terrain types, heights + provenance |
| `extract_cards.py` | the pipeline; writes `data/maps` and `data/terrain` |
| `render_overlay.py` | `docs/maps/overlays/*.png` — extraction over the card, and beside it |
| `validate_maps.py` | the acceptance gates (G1–G9), used for the QA table in `docs/MAPS.md` |
| `test_extract.py` | detector regression tests on synthetic cards — the only part of this pipeline CI can run |

## Method

### 1. Calibration (asserted per card, never assumed)

**Open killzones** (Volkus, Bheta-Decima) — card 743×550 px. The board interior
is the bounding box of the printed tints: x ∈ [12, 732), y ∈ [11, 539) = exactly
720 × 528 px over a 30" × 22" board ⇒ **24.0000 px/inch** on both axes. The
printed 1" grid is detected independently and its step measures **exactly 24.0 px**
on all 12 open cards.

**Close-quarters killzones** (Gallowdark, Tomb World) — card 702×608 px. The
3.8125" lattice is printed as a 1px multiply-darkened line whose colour depends
on the tint underneath, so it is found as "one pixel darker than both of its
neighbours" and fitted to an evenly spaced 8×7 node set. All 12 cards give
**94.000 px per lattice square** (8 x-nodes, 7 y-nodes).

Card pixels are then mapped through the *lattice*, not the card border: the
cards draw the border strip compressed, so only lattice-relative position is
trusted. The lattice is placed in the physical board frame
(703 mm × 606 mm = 27.625" × 23.875", a 7×6 lattice of 3.8125" squares centred on
it ⇒ border strips of exactly 0.46875" in x and 0.5" in y).

The y-flip from card space (y down) to board space (origin bottom-left, +y up,
x along the long edge) happens exactly once, in `Frame.to_board`.

### 2. Palette

Every colour is read off the legend swatch PNGs in `keys/` — `A-Drop.png`,
`A-Territory.png`, `B-Drop.png`, `B-Territory.png`, `Hazardous.png`, `A-Obj.png`,
`B-Obj.png`, `A-Edge.png`, `B-Edge.png`, `N-Edge.png` — and verified against the
cards. Terrain green is alpha-blended over whatever tint is beneath it, so it is
a small family of values rather than one (`GREEN_MID`, `GREEN_DARK`).

### 3. Board furniture

* **Drop zones** — the solid drop tint forms a band from one board edge. Its
  depth is measured and snapped: to 1/8" on the open cards, to the lattice on the
  close-quarters ones. *(Trap: on the CQ cards the darkened lattice line over P2
  territory lands within 2 of the P2 drop-zone grid colour, so only the solid
  fills may be used for the band.)*
* **Territories / centre line / flank line** — derived: the centre line is the
  board mid-line parallel to the drop-zone edges, the flank line is
  perpendicular to it through the board centre (the thin solid grey line the
  cards print for the Recon "Flank" tac op). The printed territory seam is
  measured independently as a QA figure (`centreSeamErrIn`).
* **Killzone edges** — the dotted strip outside the board is classified per side
  into P1 / P2 / neutral runs.
* **Objective markers** — each marker prints as a white annulus 32–33 px across;
  the disc *inside* it gives the owner (orange = P1, grey = P2, black = neutral).
  Markers are bound to the feature they stand on. Appendix › GAME SEQUENCE:
  *"Other than in Killzone: Bheta-Decima, all objective markers must be set up on
  the killzone floor"* — so outside Bheta-Decima `z` is forced to 0 even when the
  marker falls inside a stronghold or large ruin (`onFeatureId` is still
  recorded, because the marker is under that structure's upper level). On
  Bheta-Decima the marker takes the height of the feature it stands on, except
  where the card prints the "BENEATH THERMOMETRIC CONDENSER" callout (map 6),
  which is detected as a large black annotation box and forces `z` back to 0.
* **Hazardous areas** (Bheta-Decima) — the ocean tint, traced.

### 4. Labels (OCR)

Every terrain piece carries a printed letter. Chips are opaque fills —
`(79,85,90)` on Volkus/Bheta-Decima, `(103,103,98)` on the CQ wall labels,
`(0,0,0)` on the Tomb World light-terrain and teleport-pad labels — found by
exact colour, small-hole filling (the white text punches holes) and a 3×3 opening
(to sever the same-coloured Bheta-Decima gantry outline).

OCR is **exact-bitmap matching**: the cards are vector renders at one fixed
scale, so each character is pixel-identical up to a handful of sub-pixel
rasterisation variants. `labels.GLYPHS` maps `"<w>x<h>.<sha1>"` to the character.
Regenerate the contact sheet of unmapped signatures with
`python3 tools/maps/labels.py --dump`, read it, and add the entries.

Result: 14/14 letters on every Volkus card, 9/9 on every Bheta-Decima card,
15–16 wall labels per Gallowdark card and 19–23 per Tomb World card.

### 5. Terrain tracing

Masks are closed with a 0.07" disc, blobs under 0.20 sq in are dropped as print
noise, rings are simplified with Douglas-Peucker at 0.07" and wound CCW in board
space. (Kill Team pieces are small — these tolerances are deliberately tight.
`cardlib.simplify` cuts the ring at two extreme vertices before running RDP,
because RDP on a closed ring has a zero-length baseline and would collapse it.)

Per killzone:

* **Volkus** — green blobs are the upper levels and rubble footprints; the darker
  green is Stronghold B's highest level; structural ink is the black wall stroke,
  isolated with a 5×5 opening (which discards the thinner centre-line dashes,
  drop-zone arrows and marker rings) and grown back to full width, then
  decomposed into axis-aligned rectangles so each wall bar is its own part.
  White dashes across a wall are **doors** (`keys/VS2.png`: *"The position of a
  door is represented by these thick white dashed lines"*); a white dashed
  *rectangle* marks a piece that tucks under the adjacent raised level (D-014),
  and that rectangle — not the green — is the piece's footprint.
* **Bheta-Decima** — gantry decks and the condenser are traced from green and
  separated along their printed outline; decks that were one blob before that cut
  are touching, i.e. *"treated as the same terrain"*, and share a `groupId`. A
  chipless blob wholly inside another is the condenser's inner ledge.
* **Gallowdark / Tomb World** — walls are tested per lattice *edge* (17 samples,
  80% coverage), maximal straight runs are formed, and each run is tiled with the
  labelled pieces (`A*` = 2 squares, `B*` = 1) centred on their chips. Wall stroke
  thickness is measured perpendicular to occupied edges, away from the nodes
  (where the printed pillar blocks are 2–3× wider). Access points (hatchway or
  breach point, per the piece) come from the printed dark pill —
  `keys/TW3.jpg`: *"ACCESS POINT POSITION ON WALL"*. Teleport pads, the
  sarcophagus and debris come from the black label chips.

### 5a. Dashed rectangles (D-014)

`dashed_rects()` recognises an outline by **geometry**, never by a count of dash
segments. A count is scale-dependent and a dashed rectangle is not: piece I
(2 × 3.5") has a 264px perimeter and ~20 segments, piece K (0.75 × 1.979") has
131px and ~8, and the opaque label pill — which on these cards sits *on* the
outline rather than inside it — swallows two to four more. The old `parts >= 5`
gate therefore fired on every large rectangle and missed every small one, and a
missed rectangle is not a null result: the piece stays in `chips`, so
`split_blob_by_chips()` carves it out of the neighbouring green blob and
*both* pieces end up wrong.

What is tested instead, on the group of dashes:

1. the fitted box is at least 0.5" on both sides;
2. essentially every dash (≥ 90 % of them) lies within 4px of that box's
   perimeter — **rectangularity**, which is the property D-014 actually depends
   on;
3. the dashes cover at least 35 % of the **visible** perimeter overall and 25 %
   of each visible edge, so an outline missing a whole side is rejected.

"Visible" is the other half of the fix. Label pills and objective markers are
opaque: the card cannot print a dash under one, so the perimeter they hide is
dropped from both sides of the coverage ratio rather than counted as a miss.
Their boxes are also *bridged* during grouping — a pill on a piece narrower than
itself cuts the outline into two arcs, and those arcs are one rectangle.

Dashes are grouped twice: an isotropic dilation (which joins the two strokes
meeting at a corner) and directional ones that close the gaps *along* an edge,
where the printed rhythm varies. If the wider grouping swallows two pieces
printed less than ~0.9" apart, the box fails the geometry test and the tighter
grouping is retried inside it, so a close pair degrades to two rectangles rather
than to none.

`tools/maps/test_extract.py` pins all of this on synthetic cards drawn to the
same conventions, at every Volkus rubble size, in both rotations, across three
dash rhythms, with the pill in the middle of an edge and on a corner. The
official cards are GW IP and not in the repository, so this is the only part of
the pipeline CI can run.

### 6. Templates and the IoU gate

The same physical piece is drawn with the same vector art on every card, so a
piece's instances should differ only by a 90°-multiple rotation and an optional
mirror. For each label the extractor picks the **medoid** instance as the
template and fits every instance to it (`rotDeg`, `flip`), reporting the IoU.
The template footprint is the piece's own outline (upper level / rubble /
pad), falling back to the largest wall bar for pieces that are nothing but wall.

`data/terrain/<killzone>.json` carries those templates as local-space footprints.

The gate has two tiers. Below **0.92** a feature is reported; below **0.85** the
polygon is not the piece it claims to be and `validate_maps.py` fails, because
nothing downstream — board render, visibility, movement — can tell a corrupted
footprint from a real one. Genuine exceptions are allow-listed by
`(mapId, label)` in `IOU_ALLOW` with the reason, and an entry whose feature now
fits is itself a gate failure, so the list cannot outlive the bug it documents.
`tests/maps-rubble.test.ts` carries the same list from the other side: every
rubble piece must be a 4-vertex rectangle at its template size.

## Known limitations

* Rules parts the cards do not draw are **not** in the geometry, only in
  `data/terrain/*.json` `notes`: the Volkus stronghold's vent, barrel
  containers, fire steps and small ramparts; the large ruin's door viewpoint and
  unbroken windows; the gap on Stronghold B's lower Vantage level; the
  Bheta-Decima gantry pillars; the Gallowdark/Tomb World board-edge pillars and
  pillar caps.
* The green ticks along some Tomb World walls indicate the **Necron-Warrior
  modelled side** of the wall (`keys/TW1.jpg`), not a breach point, and are
  deliberately ignored.
* Heights are researched, not extracted; see the table in `docs/MAPS.md`.
