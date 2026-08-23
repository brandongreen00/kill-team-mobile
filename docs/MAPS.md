# Killzone maps — extraction, geometry and QA

All 24 Approved Ops 2025 killzone map layouts, extracted programmatically from the
official map-card PNGs into `data/maps/<killzone>/<killzone>-N.json`, plus the
terrain piece catalogue in `data/terrain/<killzone>.json`.

Regenerate with `pnpm maps:extract && pnpm maps:overlay && pnpm maps:validate`.
Method, tolerances and module layout: **`tools/maps/README.md`**.
Overlays for visual review: **`docs/maps/overlays/*.png`** (extraction drawn over
the card on the left, on its own on the right).

## 1. Method in brief

1. **Calibrate** the board frame from the card itself and assert it.
   *Open killzones* (Volkus, Bheta-Decima): board interior 720 × 528 px over
   30" × 22" ⇒ **exactly 24.0000 px/inch**, confirmed independently against the
   printed 1" grid (step measures 24.000 px on all 12 cards).
   *Close-quarters killzones* (Gallowdark, Tomb World): the 3.8125" lattice fits
   at **exactly 94.000 px per square** (8 × 7 nodes) on all 12 cards. Card pixels
   are mapped through the lattice, then the lattice is placed in the physical
   board frame — 703 mm × 606 mm = **27.625" × 23.875"**, a 7 × 6 lattice of
   3.8125" squares centred on it, giving border strips of exactly **0.46875"**
   (short-side ends) and **0.5"** (long-side ends).
2. **Palette** from the legend swatch PNGs in `keys/`, never guessed.
3. **Board furniture**: drop-zone bands (snapped to 1/8" / to the lattice),
   territories, centre line, flank line, killzone-edge ownership, objective
   markers (owner read from the disc inside the white annulus), hazardous areas.
4. **Labels** by exact-bitmap OCR of the printed chips — 14/14 letters on every
   Volkus card, 9/9 on every Bheta-Decima card, 15–16 wall labels per Gallowdark
   card, 19–23 per Tomb World card.
5. **Terrain** by colour mask → 0.07" morphological close → drop < 0.20 sq in →
   `find_contours` → Douglas-Peucker at 0.07" → CCW in board space. Volkus ink is
   decomposed into axis-aligned wall bars; close-quarters walls are tested per
   lattice edge and tiled with the labelled pieces.
6. **Templates**: for each card letter the medoid instance becomes the template
   and every instance is fitted to it (90°-multiple rotation + optional mirror);
   the fit IoU is the QA number below and the template footprint is written to
   `data/terrain/<killzone>.json`.

Features carry compiled **world-space** polygons in `parts[].poly`, so consumers
need no transform, alongside `placement { x, y, rotDeg, flip }` and the card
`label`.

## 2. Card conventions (owner-confirmed, 2026-08-17)

Two conventions contradict what the source brief inferred. Both are now encoded
explicitly in `tools/maps/extract_cards.py`, so a re-run reproduces them.

**D-013 — Objective markers are floor-only outside Bheta-Decima.**
Appendix › GAME SEQUENCE: *"Other than in Killzone: Bheta-Decima, all objective
markers must be set up on the killzone floor."* `_finish_objectives` therefore
forces `z = 0` for every objective in Volkus, Gallowdark and Tomb World,
**with no per-map exceptions**, even where the printed marker falls inside a
stronghold or large ruin (`volkus-4` P1 in Stronghold A, `volkus-5` P2 and
`volkus-6` centre in large ruin C). `onFeatureId` is still recorded, because the
marker is on that structure's ground floor *under* its Ceiling/Vantage upper
level — which is exactly what Ceiling terrain means. Only Bheta-Decima lifts a
marker (the thermometric condenser roof in maps 1–3), and even there map 6's
printed "BENEATH THERMOMETRIC CONDENSER" callout is detected and forces `z` back
to 0. Pinned by `tests/integration.test.ts`.

**D-014 — A dashed outline means the piece tucks UNDER the adjacent raised
terrain; a solid outline means it sits on top.** The brief read a white dashed
rectangle inside a stronghold or large ruin as "rubble on that structure's upper
level"; the owner confirmed the opposite. `dashed_rects()` finds those
rectangles and `volkus_features()` gives the piece `z0 = 0` with
`underRaisedLevel: true`, taking its footprint from the dashed rectangle (the
card only draws the part of the piece that the level above does not hide) and
leaving the raised level's own footprint continuous across it.

Two further conventions read off the printed keys rather than inferred:
white dashed lines **across a wall** are doors (`keys/VS2.png`); the dark pill
beside a close-quarters wall is an **access point** — a hatchway or a breach
point depending on the wall type (`keys/TW3.jpg`). The green ticks along some
Tomb World walls mark the *Necron-Warrior modelled side of the wall*
(`keys/TW1.jpg`), **not** a breach point, and are deliberately ignored.

## 3. Per-map table

`P1 killzone edge` is in engine coordinates (origin bottom-left, +y up, x along
the long edge). Objectives are `(x, y)` in inches. `IoU` is min / median of the
fitted-template match over that map's features. `Sym` is the fraction of the
terrain footprint that maps onto itself under a 180° rotation — Approved Ops
layouts are deliberately asymmetric (Killzones › SETTING UP KILLZONES:
*"Try to avoid symmetrical killzones"*), so a low number is expected, not a fault.

| Map | P1 killzone edge (engine coords) | Deployment | Drop depth | Objective P1 | Objective P2 | Objective centre | Features | IoU min / med | Sym | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bheta-decima-1` | (30, 22)–(30, 0) | short-edge (P1 right) | P1 6" / P2 6" | (17.5, 9.75) z=3 on&nbsp;B2 | (12.5, 17.75) z=3 on&nbsp;B | (15.042, 5.25) z=3 on&nbsp;D | 9: A B C D | 0.95 / 0.98 | 0.32 |  |
| `bheta-decima-2` | (30, 22)–(30, 0) | short-edge (P1 right) | P1 4" / P2 4" | (16.25, 18.25) | (13.75, 3.75) | (15, 11) z=3 on&nbsp;D | 9: A B C D | 0.96 / 1.00 | 0.47 |  |
| `bheta-decima-3` | (30, 22)–(30, 0) | short-edge (P1 right) | P1 4" / P2 4" | (16.25, 3.75) | (13.75, 18.25) | (15.042, 11.292) z=3 on&nbsp;D | 9: A B C D | 0.96 / 1.00 | 0.52 |  |
| `bheta-decima-4` | (0, 22)–(30, 22) | long-edge (P1 top) | P1 3" / P2 3" | (27.042, 12.75) | (2.75, 9) | (20.5, 11) z=3 on&nbsp;D | 9: A B C D | 0.94 / 0.97 | 0.27 |  |
| `bheta-decima-5` | (0, 22)–(30, 22) | long-edge (P1 top) | P1 3" / P2 3" | (27.75, 12.75) | (7.542, 11) z=3 on&nbsp;D | (15, 9) | 9: A B C D | 0.94 / 1.00 | 0.20 |  |
| `bheta-decima-6` | (0, 22)–(30, 22) | long-edge (P1 top) | P1 3" / P2 3" | (25.75, 12.75) | (4, 9) z=3 on&nbsp;D | (16.5, 11.042) z=3 on&nbsp;A2 | 9: A B C D | 0.40 / 0.98 | 0.33 |  |
| `gallowdark-1` | (0.063, 23.875)–(27.643, 23.875) | long-edge (P1 top) | P1 4.3125" / P2 4.3125" | (6.248, 15.73) | (23.364, 8.105) | (15.739, 11.917) | 15: A1 A2 A3 A4 B1 B2 B3 | 1.00 / 1.00 | 0.34 |  |
| `gallowdark-2` | (0.063, 23.875)–(27.643, 23.875) | long-edge (P1 top) | P1 4.3125" / P2 4.3125" | (21.498, 15.73) | (15.739, 8.064) | (6.289, 11.917) | 15: A1 A2 A3 A4 B1 B2 B3 | 1.00 / 1.00 | 0.46 |  |
| `gallowdark-3` | (0.063, 23.875)–(27.643, 23.875) | long-edge (P1 top) | P1 4.3125" / P2 4.3125" | (13.711, 15.73) | (4.302, 8.105) | (23.364, 12.039) | 16: A1 A2 A3 A4 B1 B2 B3 | 1.00 / 1.00 | 0.42 |  |
| `gallowdark-4` | (27.625, 23.781)–(27.625, 0.013) | short-edge (P1 right) | P1 4.2812" / P2 4.2812" | (15.739, 19.542) | (11.927, 4.292) | (13.873, 11.917) | 16: A1 A2 A3 A4 B1 B2 B3 | 1.00 / 1.00 | 0.51 |  |
| `gallowdark-5` | (27.625, 23.781)–(27.625, 0.013) | short-edge (P1 right) | P1 4.2812" / P2 4.2812" | (15.739, 4.292) | (11.927, 19.542) | (13.873, 11.917) | 16: A1 A2 A3 A4 B1 B2 B3 | 1.00 / 1.00 | 0.58 |  |
| `gallowdark-6` | (27.625, 23.781)–(27.625, 0.013) | short-edge (P1 right) | P1 4.2812" / P2 4.2812" | (15.739, 11.917) | (11.927, 19.542) | (13.873, 4.292) | 16: A1 A2 A3 A4 B1 B2 B3 | 1.00 / 1.00 | 0.28 |  |
| `tomb-world-1` | (0, 23.781)–(0, 0.013) | short-edge (P1 left) | P1 4.2812" / P2 4.2812" | (10.223, 21.327) | (17.564, 17.514) | (13.792, 8.105) | 20: A1 A2 A3 A4 B1 B2 B3 B4 B? C1 C2 C3 C4 C5 T | 0.50 / 1.00 | 0.18 |  |
| `tomb-world-2` | (0, 23.781)–(0, 0.013) | short-edge (P1 left) | P1 4.2812" / P2 4.2812" | (11.927, 21.448) | (15.739, 2.67) | (13.792, 11.917) | 23: A1 A2 A3 A4 B1 B2 B3 B4 C1 C2 C3 C4 C5 T | 1.00 / 1.00 | 0.41 |  |
| `tomb-world-3` | (0, 23.781)–(0, 0.013) | short-edge (P1 left) | P1 4.2812" / P2 4.2812" | (10.629, 4.292) | (17.037, 19.542) | (13.792, 11.917) | 21: A1 A2 A3 A4 B1 B2 B3 B4 C1 C2 C3 C4 C5 T | 1.00 / 1.00 | 0.40 |  |
| `tomb-world-4` | (0.063, 0)–(27.643, 0) | long-edge (P1 bottom) | P1 4.3125" / P2 4.3125" | (21.417, 8.105) | (5.883, 15.73) | (13.833, 11.958) | 23: A1 A2 A3 A4 B1 B2 B3 B4 C1 C2 C3 C4 C5 T | 0.99 / 1.00 | 0.57 |  |
| `tomb-world-5` | (0.063, 0)–(27.643, 0) | long-edge (P1 bottom) | P1 4.3125" / P2 4.3125" | (23.364, 8.105) | (5.802, 15.73) | (15.05, 11.917) | 23: A1 A2 A3 A4 B1 B2 B3 B4 C1 C2 C3 C4 C5 T | 0.91 / 1.00 | 0.15 |  |
| `tomb-world-6` | (0.063, 0)–(27.643, 0) | long-edge (P1 bottom) | P1 4.3125" / P2 4.3125" | (15.496, 8.064) | (19.552, 15.73) | (3.206, 11.917) | 22: A1 A2 A3 A4 B1 B2 B3 B4 C1 C2 C3 C4 C5 T | 0.96 / 1.00 | 0.14 |  |
| `volkus-1` | (30, 22)–(30, 0) | short-edge (P1 right) | P1 6" / P2 6" | (18.188, 3.771) | (11.771, 10.188) | (14.979, 16.021) | 14: A B C D E F G H I J K L M N | 0.71 / 1.00 | 0.23 |  |
| `volkus-2` | (30, 22)–(30, 0) | short-edge (P1 right) | P1 6" / P2 6" | (18.771, 12.771) | (11.229, 17.229) | (14.979, 3.771) | 14: A B C D E F G H I J K L M N | 0.79 / 1.00 | 0.32 |  |
| `volkus-3` | (30, 22)–(30, 0) | short-edge (P1 right) | P1 6" / P2 6" | (19.021, 3.812) on&nbsp;D | (11.229, 19.271) | (14.979, 11.021) | 14: A B C D E F G H I J K L M N | 0.36 / 1.00 | 0.30 |  |
| `volkus-4` | (0, 22)–(30, 22) | long-edge (P1 top) | P1 3" / P2 3" | (7.062, 12.896) on&nbsp;A | (14.979, 9.229) | (24.229, 11.021) | 14: A B C D E F G H I J K L M N | 0.91 / 0.99 | 0.09 |  |
| `volkus-5` | (0, 22)–(30, 22) | long-edge (P1 top) | P1 3" / P2 3" | (25.229, 13.729) | (5.188, 8.021) on&nbsp;C | (14.979, 11.021) | 14: A B C D E F G H I J K L M N | 0.32 / 0.99 | 0.31 |  |
| `volkus-6` | (0, 22)–(30, 22) | long-edge (P1 top) | P1 3" / P2 3" | (23.771, 13.771) | (7.021, 8.188) | (14.979, 11.021) on&nbsp;C | 14: A B C D E F G H I J K L M N | 0.23 / 0.99 | 0.21 |  |

## 4. Heights, provenance and confidence

Heights are **researched, not extracted** — the cards are top-down and carry no
elevation. Confidence is one of `measured` (a published GW dimension),
`photogrammetry` (measured off a key image against a known reference),
`community` (a published third-party measurement of the real sprues) or
`assumed`. **No measured height is rounded to a rules threshold**; values that
land within 0.25" of 1"/2"/3"/4" are flagged in the table.

| Height id | Inches | Confidence | Provenance |
| --- | --- | --- | --- |
| `volkus.strongholdA.top` | **5.906"** | `community` | Tale of Painters, "Review: Kill Team: Hivestorm Pt.1" (2024-09): Stronghold A (promethium-tank build) "footprint of approx. 18 x 13 cm, with a max. height of 15 cm" -> 150mm / 25.4 |
| `volkus.strongholdA.level1` | **3.000"** | `community` | Tale of Painters, Hivestorm review: Stronghold A has "a floor at 3″ height" |
| `volkus.strongholdB.top` | **7.480"** | `community` | Tale of Painters, Hivestorm review: Stronghold B "footprint of approx. 19 x 19cm, a maximum height of 19 cm" -> 190mm / 25.4 |
| `volkus.strongholdB.level1` | **3.000"** | `community` | Tale of Painters, Hivestorm review: Stronghold B "floors placed at 3″ and 6″ height" |
| `volkus.strongholdB.level2` | **6.000"** | `community` | Tale of Painters, Hivestorm review: Stronghold B "floors placed at 3″ and 6″ height" |
| `volkus.largeRuin.level1` | **3.500"** | `community` | Tale of Painters, Hivestorm review: Manufactorum Ruins have "a top floor (placed at 3.5″ from the bottom)". Killzones rules: for intervening and targeting lines this level is TREATED as the height of a stronghold’s first upper level (3.0") — see `treatAsZ`. |
| `volkus.largeRuin.top` | **4.500"** | `assumed` | No published figure. Upper rampart modelled as 1" of Light parapet above the 3.5" floor. CONFIRM WITH OWNER. |
| `volkus.smallRuin.top` | **2.000"** | `assumed` | No published figure; the small ruin is a low corner wall roughly two thirds the height of a stronghold’s first floor. CONFIRM WITH OWNER. |
| `volkus.heavyRubble.top` | **1.500"** | `assumed` | No published figure. Heavy rubble is modelled taller than a 32mm base is wide but below the 2" jump/drop threshold. CONFIRM WITH OWNER. |
| `volkus.lightRubble.top` | **1.000"** | `assumed` | No published figure. CONFIRM WITH OWNER. |
| `volkus.wreckage.top` | **1.250"** | `assumed` | Piece L (long wreckage) is not in the core-book Volkus inventory and has no published rules entry. CONFIRM WITH OWNER. ⚠ within 0.25" of the 1" rules threshold — **not** snapped |
| `volkus.crates.top` | **1.500"** | `assumed` | Piece N (cargo-crate stack) is not in the core-book Volkus inventory and has no published rules entry. CONFIRM WITH OWNER. |
| `cq.wall.top` | **2.362"** | `community` | Tale of Painters, "Review: Kill Team: Into the Dark – Part 1" (2022-09): "the Gallowdark elements have a height of 6 cm" -> 60mm / 25.4. Wall terrain blocks movement and visibility by rule regardless of height. |
| `cq.wall.double` | **4.724"** | `community` | Tale of Painters, Into the Dark review: "Two Gallowdark elements have a height of 12 cm". |
| `cq.teleportPad.top` | **0.200"** | `photogrammetry` | Measured off keys/TW3.jpg (teleport pad product photo) against its own 3.8125" square footprint: the pad is a shallow disc, ~5% of its width. It is Insignificant terrain, so the exact value never affects climb/drop. |
| `cq.light.top` | **1.200"** | `assumed` | Sarcophagus / debris are Light terrain; no published height. CONFIRM WITH OWNER. ⚠ within 0.25" of the 1" rules threshold — **not** snapped |
| `bheta.gantry.deck` | **3.000"** | `owner-confirmed` | NO published measurement found for the Bheta-Decima gantries (checked GW product pages, Tale of Painters and Goonhammer reviews, and the Kerlin killzone PDF). 3.0" is chosen because it matches the Volkus stronghold first floor, keeps the deck inside the 3" climb reach from the killzone floor, and above the 2" free-drop threshold. **Confirmed by the owner 2026-08-17** ("3 inches is a fine assumption"). |
| `bheta.condenser.roof` | **3.000"** | `derived` | No published measurement. Set equal to the owner-confirmed gantry deck so the roof and adjoining gantries read as one level. Derived, not independently confirmed. |
| `bheta.condenser.ledge` | **2.750"** | `assumed` | The inner ledge is Exposed + Insignificant, i.e. the rules explicitly say to ignore the slight height difference, so this value is cosmetic. CONFIRM WITH OWNER. ⚠ within 0.25" of the 3" rules threshold — **not** snapped |
| `bheta.condenser.battlement` | **3.750"** | `assumed` | Battlements modelled as 0.75" of Light parapet above the roof. CONFIRM WITH OWNER. ⚠ within 0.25" of the 4" rules threshold — **not** snapped |

### Heights to confirm with the owner (highest value first)

1. ~~**`bheta.gantry.deck`**~~ — **CONFIRMED by the owner 2026-08-17 at 3.0"**. No
   published measurement exists (GW product pages, Tale of Painters and Goonhammer
   reviews, and the Kerlin killzone PDF were all checked), so this was the single
   most load-bearing assumed value: it decides every climb, drop and Vantage
   interaction on six maps. `bheta.condenser.roof` (3.0") follows from it and is
   confirmed with it; `.ledge` (2.75") and `.battlement` (3.75") remain derived
   assumptions, though both are cosmetic — the ledge is Exposed + Insignificant, so
   the rules say to ignore its height difference.
2. **`volkus.smallRuin.top` (2.0"), `volkus.heavyRubble.top` (1.5"),
   `volkus.lightRubble.top` (1.0")** — no published figures. These sit right on
   the 2" free-drop threshold, so they change how operatives cross the board.
3. **`volkus.largeRuin.top` (4.5", assumed)** — the upper *rampart* height. The
   floor beneath it (3.5") is published.
4. **`cq.light.top` (1.2")** — Tomb World sarcophagus and debris.
5. **`volkus.wreckage.top` / `volkus.crates.top`** — pieces L, M and N are on
   the Volkus map cards and in `keys/VS1.png` but are **not** in the core-book
   Volkus inventory (2× stronghold, 2× large ruin, 2× small ruin, 2× heavy
   rubble, 3× light rubble) and have **no rules entry**, so both their heights
   *and their terrain types* are assumed (L and M as Light, N as Heavy).
6. **`cq.wall.top` (2.362", community)** — worth a sanity check. Wall terrain
   blocks movement and visibility by rule regardless of height, so this only
   matters for climbing onto a wall, which the rules do not permit anyway.

Two rules-level height notes are carried in the data rather than baked in:
the Volkus large ruin's floor is physically 3.5" but the Killzones page says to
*treat it as a stronghold's first upper level* (3.0") for intervening and
targeting lines — carried as `treatAsZ`; and Stronghold B's highest level takes
at most one friendly operative — carried as `maxOperatives: 1`.

## 5. QA gates

`pnpm maps:validate` — **24 maps, 0 gate failures** (re-run 2026-08-23 against the cards).

| Gate | Check | Result |
| --- | --- | --- |
| G1 | px/inch asserted per card | 24.0000 on all 12 open cards; 94.000 px/lattice square on all 12 CQ cards |
| G2 | no polygon off-board, none degenerate | pass on all 24 |
| G3 | piece counts within the printed killzone inventory | pass on all 24 |
| G4 | every feature labelled | 1 exception: `tomb-world-1.B?-1` |
| G5 | exactly 3 objectives (p1/p2/centre) | pass on all 24 |
| G6 | drop-zone depth is a printed value | pass — Volkus 6"/3", Bheta-Decima 6"/4"/3", CQ 4.3125" (long-edge) / 4.28125" (short-edge) |
| G7 | fitted-template IoU: ≥ 0.92 is reported, **< 0.85 fails the build** | median 0.97–1.00 on every map; 20 features below 0.92, of which 13 are below 0.85 and carry an explicit allow-list entry with a reason (`IOU_ALLOW` in `validate_maps.py`) — see §6 |
| G8 | CQ wall centrelines within 0.1" of the lattice | worst 0.0003" |
| G9 | 180° rotational symmetry | reported, not gated (0.09–0.58; the layouts are asymmetric by design) |

Objective-marker accuracy: the neutral marker sits within **0.02"–0.10"** of the
centre line on 23 maps. `bheta-decima-5` is the exception — its neutral marker is
genuinely printed 2.0" into P2 territory, so the check is a report, not a gate.

Territory-seam check (`centreSeamErrIn`, the printed tint boundary against the
derived centre line): **≤ 0.041" on all 24 maps**.

### Access points (`pnpm maps:extract`)

A Close Quarters hatchway or breach point is printed as a dark pill (RGB 63,57,52, 49×14px)
drawn **alongside** the wall it belongs to, with its long axis running along that wall. Two
things were wrong with how that was read.

The **match** was `abs(offset) < wall_thickness * 2.2`, i.e. 19.8px. Measured across all twelve
Close Quarters cards, the perpendicular offset of a pill from the wall it marks clusters at
**18–22px** (118 pairs) and the nearest unrelated pairing is at **73px** — a 3.5× gap. The old
threshold cut straight through the middle of the true cluster: 3 access points out of 10 pills
on gallowdark-1, and **zero on every Tomb World card**. It is now `thickness * 4` = 36px, which
sits in the gap.

The **placement** put a small square at the pill's centre — which is beside the wall, not in
it — so the wall ran unbroken behind the access point and opening a hatchway changed nothing:
`wallRouteDistance` across one was Infinity open or closed. The access point now takes the
wall's own thickness and the pill's long extent, and the wall is emitted as two bars either
side of it. It is a gap in the wall, which is what a doorway is.

| Killzone | hatchways | breach points | before |
| --- | --- | --- | --- |
| Gallowdark | 59 | 0 | 6 access points across all six maps |
| Tomb World | 36 | 22 | **0** |

`tests/rules-review.test.ts` pins both halves on the shipped data: no wall part may overlap an
access point of its own feature, and with every hatchway open an operative must reach across
more than 70% of the board in each axis. On the previous data gallowdark-1's vertical reach was
10" on a 23.9" board — one compartment.

Template fitting changed with it: a piece that is nothing but wall is now matched on the extent
of the whole run rather than its largest bar, because which bar is larger is an accident of
where the hatchway sits.

### Doors (`pnpm maps:doors:check`)

`_volkus_doors` reads a door off the card as a white dashed segment printed across the wall,
and demands a blob 12–14 px on its short side. In practice that only ever fired on Stronghold
B, so **18 of the 24 door-bearing features shipped with the doorway as an unmodelled hole** in
the wall ring — not Accessible, not Heavy, not there. The gap cost nothing to cross, gave no
cover and obscured nobody; and once a move increment is checked against terrain (D-064), a
1.17" hole is narrower than a 32 mm base, so the buildings would have sealed shut instead.

`tools/maps/doors.py` recovers the door from the hole itself and `pnpm maps:doors` writes it
in (it also runs inside `pnpm maps:extract`, so a re-extraction produces the same data). Two
doorways additionally had a wall bar traced across them; those are clipped back out.

| Piece | Instances | Door width | Resolved from |
| --- | --- | --- | --- |
| Stronghold A | 6 | 1.17" | wall ring ×5, consensus ×1 (volkus-5, whose top wall traces as three sub-thickness slivers) |
| Stronghold B | 6 | 1.92" | read off the card by `_volkus_doors`; reproduced exactly by the derivation as a check |
| Large Ruin | 12 | 1.88" | wall ring ×12 |

The derivation is validated rather than assumed: given nothing but wall geometry it lands on
all six card-read Stronghold B doors to within the rounding of the stored polygons.
`tools/maps/test_doors.py` pins that, plus one-door-per-feature and Accessible + Heavy typing;
`tests/maps-volkus-doors.test.ts` walks an operative through every door and into every wall on
the real shipped maps.

### D-014 is half closed

Re-extracting from the cards with the fixed `dashed_rects()` recovered **volkus-6 K** and its
host **A**: K is a clean rectangle again and Stronghold A's floor is whole (4.396–9.771 rather
than 6.562–9.771). Their entries are deleted from `IOU_ALLOW` and from the `PENDING` list in
`tests/maps-rubble.test.ts`, as both files' own honesty checks require. `volkus-3 K/D`,
`volkus-5 J/C` and `volkus-6 C` are still carved out of their hosts.

## 6. Known nits

* **20 features below the 0.92 IoU gate** (out of 353), 13 of them below the
  0.85 hard floor and therefore allow-listed by name in `validate_maps.py`.
  - **Volkus `K`/`J` and their hosts `A`, `C`, `D` (0.23–0.79) — D-014
    dashed-rectangle recall.** *An earlier version of this section said these
    pieces were "the visible part of a piece overlapped by another piece". That
    was wrong.* `dashed_rects()` used to gate on a fixed count of dash segments,
    which every small dashed rectangle fails: piece K's 131px perimeter carries
    ~8 segments and the label pill, printed **on** the outline, hides two to
    four of them. When the outline is missed the piece stays in `chips`, so
    `split_blob_by_chips()` hands it a slice of its neighbour's green blob — a
    16–26 vertex fragment of somebody else's silhouette — and the neighbour
    loses that same slice. Both ends of the pair are corrupted, and nothing
    downstream can tell. The detector is fixed (see `tools/maps/README.md` §5);
    the six affected features stay allow-listed **until `pnpm maps:extract` is
    re-run against the cards**, which needs the local context pack.
  - **Volkus `G`, `I` where D-014 *did* fire (0.88–0.93).** The returned box is
    the outer extent of the dash stroke rather than its centreline, so the
    footprint comes out up to 0.084" (2px) large on both axes. Left as-is
    deliberately: the two independent measurements of the same piece disagree
    about it (`I` on maps 1–2 traces from green at exactly the dashed box's
    size, `G` on maps 4–6 traces 2px smaller), and picking a side needs the
    cards, not a guess.
  - Volkus `B` (0.57–0.79) on maps 1–3: Stronghold B is the only piece with two
    upper levels (3.0" and 6.0") and fits low on maps where D-014 played no
    part. **Not** a dashed-rectangle problem; tracked on its own.
  - Bheta-Decima 6 `B`, `D` (0.40–0.48): the condenser and the gantry beside it
    trace as one blob on that card and the split cuts it wrongly — the same
    *shape* of failure as D-014 (a merged blob divided between two chips) but a
    different cause: `bheta_features()` never calls `dashed_rects()`. Needs the
    card to diagnose.
  - `tomb-world-1` `A2` (0.51) and its one unlabelled wall: two label chips on
    that card are unreadable, so one long wall is tiled as two 1-square segments.
  - `tomb-world-5` `C5` (0.91) is a hair under the gate.
* **`data/terrain/volkus.json` → `footprints` is wrong for multi-part pieces.**
  It stores one placed part rather than the union of them, so Stronghold A reads
  as 5.374 × 5.563 against a built 8 × 6, and the small ruins E/F as a single
  0.208" wall strip. Rubble pieces G–N round-trip correctly, which is why it is
  easy to miss. Tracked separately from D-014.
* **Parts the cards do not draw** are described in `data/terrain/*.json` `notes`
  but are absent from the geometry: the Volkus stronghold's broken vent
  (Blocking), the three barrel containers on Stronghold A (Blocking + Heavy),
  the fire steps and small ramparts (Vantage/Insignificant/Exposed), the gap on
  Stronghold B's lower Vantage level (Accessible), the large ruin's door
  viewpoint (Blocking) and unbroken windows (Barred + Heavy), the Bheta-Decima
  gantry pillars (Heavy), and the Gallowdark/Tomb World board-edge pillars and
  pillar caps.
* **Board-frame nuance**: the close-quarters lattice square is taken as exactly
  3.8125"; GW's published tile is 9.7 cm = 3.8189", a difference of 0.045" over
  the full 7 squares. The board dimensions used (27.625" × 23.875") are the
  1/8"-rationalised form of 703 mm × 606 mm.
* **Bheta-Decima 5** prints a pale non-hazardous floor disc beside the condenser;
  it is correctly excluded from `hazardous` (it is floor, not ocean) but is not
  modelled as a distinct feature.
