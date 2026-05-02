// Shared map data and geometry helpers for Tomb World battlefields.
// Coordinates are in inches. Standard board is 28" wide x 24" tall (7 x 6 grid of 4" squares).
// Each map has a deployment split (vertical or horizontal). Player A (Imperium / orange)
// always occupies the orange half; Player B (Chaos / grey) the grey half.

(function (root) {
  const TOMB_BOARD = { width: 28, height: 24, gridSize: 4 };

  // --- Geometry helpers ---------------------------------------------------

  function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  }

  function segIntersect(p1, p2, p3, p4) {
    // Returns true if segment p1-p2 intersects segment p3-p4 (excluding shared endpoints).
    const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
    if (Math.abs(d) < 1e-9) return false;
    const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
    const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
    const eps = 1e-6;
    return ua > eps && ua < 1 - eps && ub > eps && ub < 1 - eps;
  }

  function pointSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function losBlocked(map, x1, y1, x2, y2) {
    const a = { x: x1, y: y1 }, b = { x: x2, y: y2 };
    for (const w of map.walls || []) {
      if (segIntersect(a, b, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) return true;
    }
    return false;
  }

  function moveBlocked(map, x1, y1, x2, y2) {
    return losBlocked(map, x1, y1, x2, y2);
  }

  function inDeployZone(map, team, x, y) {
    const z = deployZone(map, team);
    return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
  }

  // Explicit deployment squares (the deeper-shaded zones). When a map carries
  // any squares for a team they are the strict deployment area; otherwise the
  // whole half remains the implicit deployment zone (legacy behaviour).
  function deploySquares(map, team) {
    return (map && map.deployZones || []).filter(z => z.team === team);
  }

  function inDeploySquare(map, team, x, y) {
    const squares = deploySquares(map, team);
    if (!squares.length) return inDeployZone(map, team, x, y);
    return squares.some(z => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h);
  }

  function deployZone(map, team) {
    const W = TOMB_BOARD.width, H = TOMB_BOARD.height;
    if (map.split === 'vertical') {
      // Orange (A) on left, grey (B) on right.
      return team === 'A'
        ? { x: 0, y: 0, w: W / 2, h: H }
        : { x: W / 2, y: 0, w: W / 2, h: H };
    }
    // Horizontal: grey (B) on top, orange (A) on bottom.
    return team === 'A'
      ? { x: 0, y: H / 2, w: W, h: H / 2 }
      : { x: 0, y: 0, w: W, h: H / 2 };
  }

  // Build perimeter wall segments for the board border.
  function perimeter() {
    const { width: W, height: H } = TOMB_BOARD;
    return [
      { x1: 0, y1: 0, x2: W, y2: 0 },
      { x1: W, y1: 0, x2: W, y2: H },
      { x1: W, y1: H, x2: 0, y2: H },
      { x1: 0, y1: H, x2: 0, y2: 0 },
    ];
  }

  // Helper to build a closed-room rectangle (with optional doors as gaps).
  // doors: array of {side:'top'|'bottom'|'left'|'right', at: number, span: number}
  function room(x, y, w, h, doors = []) {
    function side(x1, y1, x2, y2, name) {
      const ds = doors.filter(d => d.side === name).sort((a, b) => a.at - b.at);
      if (!ds.length) return [{ x1, y1, x2, y2 }];
      const segs = [];
      const horizontal = y1 === y2;
      const span0 = horizontal ? x1 : y1;
      const span1 = horizontal ? x2 : y2;
      let cur = span0;
      for (const d of ds) {
        const a = d.at, b = d.at + d.span;
        if (a > cur) {
          if (horizontal) segs.push({ x1: cur, y1, x2: a, y2 });
          else segs.push({ x1, y1: cur, x2, y2: a });
        }
        cur = Math.max(cur, b);
      }
      if (cur < span1) {
        if (horizontal) segs.push({ x1: cur, y1, x2: span1, y2 });
        else segs.push({ x1, y1: cur, x2, y2: span1 });
      }
      return segs;
    }
    return [
      ...side(x, y, x + w, y, 'top'),
      ...side(x + w, y, x + w, y + h, 'right'),
      ...side(x, y + h, x + w, y + h, 'bottom'),
      ...side(x, y, x, y + h, 'left'),
    ];
  }

  // --- Tomb World map definitions -----------------------------------------
  //
  // These are best-effort approximations of the printed Kill Team Tomb World
  // boards. Wall layouts are simplified central rooms based on the source
  // images. Refine them in the Map Creator (./map-creator.html) for exact
  // configurations. Each map preserves its deployment-zone orientation.

  const TOMB_MAPS = {
    'tomb-1': {
      id: 'tomb-1',
      name: 'Tomb World I',
      eyebrow: 'Mausoleum Halls',
      desc: 'Central crypt complex with branching corridors. Vertical deployment.',
      split: 'vertical',
      walls: [
        ...room(8, 4, 12, 4, [{ side: 'bottom', at: 13, span: 2 }]),     // upper room
        ...room(4, 12, 8, 4, [{ side: 'right', at: 13, span: 2 }]),      // mid-left room
        ...room(16, 12, 8, 4, [{ side: 'left', at: 13, span: 2 }]),      // mid-right room
        ...room(8, 20, 12, 4, []),                                       // lower room
      ],
      doors: [],
      terrain: [
        { type: 'octagon', label: 'C1', x: 4,  y: 8,  r: 2.0 },
        { type: 'square',  label: 'C5', x: 12, y: 6,  size: 2.0 },
        { type: 'square',  label: 'C3', x: 21, y: 4,  size: 2.0 },
        { type: 'square',  label: 'C4', x: 8,  y: 18, size: 2.0 },
        { type: 'square',  label: 'C2', x: 21, y: 16, size: 2.0 },
        { type: 'circle',  label: 'T',  x: 14, y: 11, r: 1.5 },
        { type: 'circle',  label: 'T',  x: 14, y: 22, r: 1.5 },
        { type: 'barricade', x: 6,  y: 14, w: 2, h: 1 },
        { type: 'barricade', x: 22, y: 14, w: 2, h: 1 },
      ],
      objectives: [
        { x: 8,  y: 4,  owner: 'A' },
        { x: 18, y: 8,  owner: 'B' },
        { x: 14, y: 18, owner: 'neutral' },
      ],
    },

    'tomb-2': {
      id: 'tomb-2',
      name: 'Tomb World II',
      eyebrow: 'Stasis Vaults',
      desc: 'Twin sealed vaults flanking a central reliquary.',
      split: 'vertical',
      walls: [
        ...room(4, 4, 8, 8, [{ side: 'bottom', at: 7, span: 2 }]),        // orange vault
        ...room(16, 4, 8, 8, [{ side: 'bottom', at: 19, span: 2 }]),     // grey vault
        ...room(4, 16, 8, 6, [{ side: 'top', at: 7, span: 2 }]),
        ...room(16, 16, 8, 6, [{ side: 'top', at: 19, span: 2 }]),
      ],
      doors: [],
      terrain: [
        { type: 'circle',  label: 'T',  x: 8,  y: 8,  r: 1.5 },
        { type: 'circle',  label: 'T',  x: 20, y: 16, r: 1.5 },
        { type: 'square',  label: 'C3', x: 7,  y: 6,  size: 2.0 },
        { type: 'square',  label: 'C2', x: 20, y: 8,  size: 2.0 },
        { type: 'octagon', label: 'C1', x: 8,  y: 22, r: 2.0 },
        { type: 'square',  label: 'C4', x: 21, y: 6,  size: 1.6 },
        { type: 'square',  label: 'C5', x: 22, y: 22, size: 1.6 },
        { type: 'barricade', x: 13, y: 11, w: 2, h: 1 },
        { type: 'barricade', x: 13, y: 13, w: 2, h: 1 },
      ],
      objectives: [
        { x: 13, y: 4,  owner: 'B' },
        { x: 13, y: 12, owner: 'neutral' },
        { x: 13, y: 21, owner: 'A' },
      ],
    },

    'tomb-3': {
      id: 'tomb-3',
      name: 'Tomb World III',
      eyebrow: 'Sepulchre Cross',
      desc: 'Cruciform corridor with central reliquary chamber.',
      split: 'vertical',
      walls: [
        ...room(4,  4, 6, 6, [{ side: 'right', at: 7, span: 2 }]),
        ...room(18, 4, 6, 6, [{ side: 'left',  at: 7, span: 2 }]),
        ...room(4,  14, 8, 6, [{ side: 'right', at: 17, span: 2 }]),
        ...room(16, 14, 8, 6, [{ side: 'left',  at: 17, span: 2 }]),
        // central chamber
        ...room(11, 9, 6, 6, [
          { side: 'top', at: 13, span: 2 },
          { side: 'bottom', at: 13, span: 2 },
        ]),
      ],
      doors: [],
      terrain: [
        { type: 'circle',  label: 'T',  x: 8,  y: 6,  r: 1.5 },
        { type: 'square',  label: 'C3', x: 5,  y: 5,  size: 1.6 },
        { type: 'octagon', label: 'C1', x: 22, y: 6,  r: 2.0 },
        { type: 'square',  label: 'C2', x: 7,  y: 16, size: 1.8 },
        { type: 'square',  label: 'C5', x: 7,  y: 21, size: 1.6 },
        { type: 'circle',  label: 'T',  x: 20, y: 21, r: 1.5 },
        { type: 'square',  label: 'C4', x: 22, y: 22, size: 1.6 },
        { type: 'barricade', x: 13, y: 7, w: 2, h: 1 },
        { type: 'barricade', x: 13, y: 17, w: 2, h: 1 },
      ],
      objectives: [
        { x: 14, y: 5,  owner: 'B' },
        { x: 14, y: 12, owner: 'neutral' },
        { x: 14, y: 19, owner: 'A' },
      ],
    },

    'tomb-4': {
      id: 'tomb-4',
      name: 'Tomb World IV',
      eyebrow: 'Necron Atrium',
      desc: 'Wide atrium with flanking gantries. Horizontal deployment.',
      split: 'horizontal',
      walls: [
        ...room(4, 4, 6, 6, [{ side: 'right', at: 7, span: 2 }]),
        ...room(11, 4, 10, 6, [
          { side: 'left', at: 7, span: 2 },
          { side: 'bottom', at: 15, span: 2 },
          { side: 'right', at: 7, span: 2 },
        ]),
        ...room(22, 4, 4, 6, []),
        ...room(8, 14, 12, 6, [
          { side: 'top', at: 13, span: 2 },
          { side: 'left', at: 17, span: 2 },
          { side: 'right', at: 17, span: 2 },
        ]),
      ],
      doors: [],
      terrain: [
        { type: 'circle',  label: 'T',  x: 6,  y: 7,  r: 1.5 },
        { type: 'circle',  label: 'T',  x: 16, y: 16, r: 1.5 },
        { type: 'square',  label: 'C4', x: 23, y: 5,  size: 1.6 },
        { type: 'square',  label: 'C3', x: 16, y: 7,  size: 1.6 },
        { type: 'square',  label: 'C5', x: 12, y: 16, size: 1.6 },
        { type: 'octagon', label: 'C1', x: 24, y: 19, r: 2.0 },
        { type: 'square',  label: 'C2', x: 22, y: 17, size: 1.6 },
        { type: 'barricade', x: 5,  y: 17, w: 2, h: 1 },
        { type: 'barricade', x: 22, y: 11, w: 1, h: 2 },
      ],
      objectives: [
        { x: 5,  y: 12, owner: 'B' },
        { x: 14, y: 12, owner: 'neutral' },
        { x: 23, y: 14, owner: 'A' },
      ],
    },

    'tomb-5': {
      id: 'tomb-5',
      name: 'Tomb World V',
      eyebrow: 'Reclamation Vault',
      desc: 'Single central vault flanked by open ground.',
      split: 'horizontal',
      walls: [
        ...room(2, 2, 8, 6, [{ side: 'right', at: 5, span: 2 }]),
        ...room(11, 2, 14, 6, [
          { side: 'left', at: 5, span: 2 },
          { side: 'right', at: 5, span: 2 },
          { side: 'bottom', at: 17, span: 2 },
        ]),
        ...room(11, 14, 14, 8, [{ side: 'top', at: 17, span: 2 }]),
        ...room(2, 17, 8, 5, []),
      ],
      doors: [],
      terrain: [
        { type: 'circle',  label: 'T',  x: 6,  y: 5,  r: 1.5 },
        { type: 'square',  label: 'C4', x: 5,  y: 5,  size: 1.4 },
        { type: 'square',  label: 'C3', x: 18, y: 5,  size: 1.6 },
        { type: 'circle',  label: 'T',  x: 23, y: 6,  r: 1.5 },
        { type: 'square',  label: 'C5', x: 14, y: 13, size: 1.6 },
        { type: 'octagon', label: 'C1', x: 24, y: 9,  r: 1.8 },
        { type: 'square',  label: 'C2', x: 22, y: 17, size: 1.6 },
        { type: 'barricade', x: 13, y: 9, w: 2, h: 1 },
        { type: 'barricade', x: 13, y: 13, w: 2, h: 1 },
      ],
      objectives: [
        { x: 14, y: 4,  owner: 'B' },
        { x: 14, y: 11, owner: 'neutral' },
        { x: 18, y: 18, owner: 'A' },
      ],
    },

    // Tomb World — Approved Ops 2. Authored from the in-game Map Creator and
    // captured here so it ships out-of-the-box. Layout uses the new
    // piece-based schema; objectives sit on the player-A, player-B, and
    // central spawn lines for asymmetric Crit Op scoring.
    'tomb-approved-2': {
      id: 'tomb-approved-2',
      name: 'Tomb World — Approved Ops 2',
      eyebrow: 'Approved Ops',
      desc: 'Vertical split with three asymmetric objectives — Blue near 12,2 · Red near 16,21 · Neutral central.',
      split: 'vertical',
      walls: [],
      doors: [],
      terrain: [],
      objectives: [
        { x: 12, y: 2,  owner: 'A' },
        { x: 16, y: 21, owner: 'B' },
        { x: 14, y: 12, owner: 'neutral' },
      ],
      pieces: [
        { kind: 'A3', x: 4,  y: 4,  rot: 1, flip: false },
        { kind: 'B1', x: 8,  y: 4,  rot: 2, flip: false },
        { kind: 'B2', x: 8,  y: 4,  rot: 3, flip: false },
        { kind: 'A1', x: 16, y: 4,  rot: 2, flip: false },
        { kind: 'A4', x: 12, y: 12, rot: 2, flip: false },
        { kind: 'B2', x: 12, y: 8,  rot: 1, flip: false },
        { kind: 'A2', x: 12, y: 20, rot: 3, flip: false },
        { kind: 'A1', x: 16, y: 12, rot: 3, flip: false },
        { kind: 'B4', x: 16, y: 16, rot: 3, flip: false },
        { kind: 'A2', x: 16, y: 12, rot: 0, flip: false },
        { kind: 'B3', x: 12, y: 24, rot: 3, flip: false },
        { kind: 'A3', x: 20, y: 20, rot: 2, flip: false },
        { kind: 'B4', x: 24, y: 20, rot: 2, flip: false },
        { kind: 'A4', x: 24, y: 20, rot: 3, flip: false },
        { kind: 'B1', x: 24, y: 8,  rot: 1, flip: false },
        { kind: 'B3', x: 16, y: 0,  rot: 1, flip: false },
        { kind: 'T',  x: 10, y: 8,  rot: 1, flip: false },
        { kind: 'T',  x: 18, y: 14, rot: 1, flip: false },
        { kind: 'C1', x: 5,  y: 20, rot: 1, flip: false },
        { kind: 'C3', x: 7,  y: 8,  rot: 1, flip: false },
        { kind: 'C2', x: 20, y: 8,  rot: 1, flip: false },
        { kind: 'C5', x: 16, y: 23.5, rot: 1, flip: false },
        { kind: 'C4', x: 23.5, y: 4,  rot: 1, flip: false },
      ],
      deployZones: [
        { team: 'A', x: 0,  y: 0,  w: 4, h: 4 },
        { team: 'A', x: 0,  y: 4,  w: 4, h: 4 },
        { team: 'A', x: 0,  y: 8,  w: 4, h: 4 },
        { team: 'A', x: 0,  y: 12, w: 4, h: 4 },
        { team: 'A', x: 0,  y: 16, w: 4, h: 4 },
        { team: 'A', x: 0,  y: 20, w: 4, h: 4 },
        { team: 'B', x: 24, y: 0,  w: 4, h: 4 },
        { team: 'B', x: 24, y: 4,  w: 4, h: 4 },
        { team: 'B', x: 24, y: 8,  w: 4, h: 4 },
        { team: 'B', x: 24, y: 12, w: 4, h: 4 },
        { team: 'B', x: 24, y: 16, w: 4, h: 4 },
        { team: 'B', x: 24, y: 20, w: 4, h: 4 },
      ],
    },

    'tomb-6': {
      id: 'tomb-6',
      name: 'Tomb World VI',
      eyebrow: 'Resurrection Crypts',
      desc: 'Crypt rows split by central scoring lane.',
      split: 'horizontal',
      walls: [
        ...room(3, 2, 6, 6, []),
        ...room(11, 4, 8, 6, [{ side: 'right', at: 11, span: 2 }]),
        ...room(20, 4, 6, 4, [{ side: 'left', at: 6, span: 2 }]),
        ...room(3, 14, 6, 4, []),
        ...room(12, 13, 8, 8, [{ side: 'top', at: 14, span: 2 }, { side: 'left', at: 16, span: 2 }]),
        ...room(22, 13, 4, 8, []),
      ],
      doors: [],
      terrain: [
        { type: 'octagon', label: 'C1', x: 5,  y: 8,  r: 2.0 },
        { type: 'circle',  label: 'T',  x: 14, y: 6,  r: 1.5 },
        { type: 'square',  label: 'C4', x: 16, y: 8,  size: 1.6 },
        { type: 'square',  label: 'C3', x: 24, y: 5,  size: 1.6 },
        { type: 'square',  label: 'C5', x: 15, y: 14, size: 1.6 },
        { type: 'circle',  label: 'T',  x: 14, y: 19, r: 1.5 },
        { type: 'square',  label: 'C2', x: 24, y: 17, size: 1.6 },
        { type: 'barricade', x: 18, y: 11, w: 2, h: 1 },
        { type: 'barricade', x: 18, y: 13, w: 2, h: 1 },
      ],
      objectives: [
        { x: 5,  y: 5,  owner: 'B' },
        { x: 16, y: 12, owner: 'neutral' },
        { x: 22, y: 19, owner: 'A' },
      ],
    },
  };

  // --- Piece registry -----------------------------------------------------
  // Tomb-world board pieces (see Map Creator). Pieces are placed on a 4" grid
  // and may carry visual markers (breach, hatchway, necron warriors). Only the
  // physical wall segment / terrain footprint affects mechanics; markers are
  // visual-only until breach / hatchway / PVE rules land.
  //
  // Coordinate model:
  //   piece = { kind, x, y, rot, flip? }
  //   - For walls: (x, y) is one endpoint; rot 0/1/2/3 = right/down/left/up
  //     (the wall extends from the anchor in that direction).
  //   - For wallend (X): (x, y) is the placed position; rot is facing dir.
  //   - For terrain (T, C1..C5): (x, y) is the centre.
  //   - rot is in 90° clockwise increments (0..3).
  //   - flip toggles which end / side carries the marker (asymmetric pieces).

  const PIECES = {
    A1: { type: 'wall',        len: 8, asymm: 'half', marker: 'breach',   label: 'A1' },
    A2: { type: 'wall',        len: 8, asymm: 'side', marker: 'necron',   label: 'A2' },
    A3: { type: 'wall',        len: 8, asymm: 'half', marker: 'hatchway', label: 'A3' },
    A4: { type: 'wall',        len: 8, asymm: 'half', marker: 'hatchway', label: 'A4' },
    B1: { type: 'wall',        len: 4, asymm: 'none', marker: null,        label: 'B1' },
    B2: { type: 'wall',        len: 4, asymm: 'none', marker: 'breach',   label: 'B2' },
    B3: { type: 'wall',        len: 4, asymm: 'none', marker: 'hatchway', label: 'B3' },
    B4: { type: 'wall',        len: 4, asymm: 'none', marker: null,        label: 'B4' },
    X:  { type: 'wallend',                                                 label: 'X'  },
    T:  { type: 'circle',      r: 1.0,                                     label: 'T'  },
    C1: { type: 'sarcophagus', w: 3.0,  h: 2.0,    cover: 'light',         label: 'C1' },
    C2: { type: 'rect',        w: 2.4,  h: 2.0,    cover: 'debris',        label: 'C2' },
    C3: { type: 'rect',        w: 1.333, h: 1.333, cover: 'debris',        label: 'C3' },
    C4: { type: 'rect',        w: 1.333, h: 1.333, cover: 'debris',        label: 'C4' },
    C5: { type: 'rect',        w: 1.333, h: 1.333, cover: 'debris',        label: 'C5' },
  };

  const PIECE_KINDS = Object.keys(PIECES);

  function rotDir(rot) {
    return [[1, 0], [0, 1], [-1, 0], [0, -1]][((rot || 0) % 4 + 4) % 4];
  }

  function pieceWallSegment(p) {
    const def = PIECES[p.kind];
    if (!def || def.type !== 'wall') return null;
    const [dx, dy] = rotDir(p.rot);
    return { x1: p.x, y1: p.y, x2: p.x + dx * def.len, y2: p.y + dy * def.len };
  }

  function pieceTerrainShape(p) {
    const def = PIECES[p.kind];
    if (!def) return null;
    if (def.type === 'circle') {
      return { type: 'circle', x: p.x, y: p.y, r: def.r, label: def.label };
    }
    if (def.type === 'rect' || def.type === 'sarcophagus') {
      const horiz = ((p.rot || 0) & 1) === 0;
      const w = horiz ? def.w : def.h;
      const h = horiz ? def.h : def.w;
      return {
        type: def.type === 'sarcophagus' ? 'sarcophagus' : 'rect',
        x: p.x, y: p.y, w, h, label: def.label, cover: def.cover,
      };
    }
    return null;
  }

  function compilePieces(pieces) {
    const walls = [], terrain = [];
    const openable = []; // indices of pieces that can toggle (hatchway / breach)
    const teleporters = []; // T pads
    (pieces || []).forEach((p, idx) => {
      const def = PIECES[p.kind];
      if (!def) return;
      const seg = pieceWallSegment(p);
      if (seg) {
        walls.push({ ...seg, pieceIndex: idx, marker: def.marker || null });
        if (def.marker === 'hatchway' || def.marker === 'breach') {
          openable.push({ pieceIndex: idx, kind: def.marker, label: def.label, x: (seg.x1 + seg.x2) / 2, y: (seg.y1 + seg.y2) / 2 });
        }
      }
      const ter = pieceTerrainShape(p);
      if (ter) terrain.push({ ...ter, pieceIndex: idx });
      if (def.type === 'circle' && def.label === 'T') {
        teleporters.push({ pieceIndex: idx, x: p.x, y: p.y, r: def.r });
      }
    });
    return { walls, terrain, openable, teleporters };
  }

  // Returns a copy of map with piece-derived walls/terrain merged in. The
  // resulting object exposes:
  //   walls       — all blocking segments (each tagged with pieceIndex if any)
  //   terrain     — light/heavy cover and decorative pieces
  //   openable    — list of hatchway/breach pieces (with pieceIndex)
  //   teleporters — list of T pads (with pieceIndex)
  function compileMap(map) {
    if (!map) return map;
    const c = compilePieces(map.pieces);
    return {
      ...map,
      walls: [...(map.walls || []), ...c.walls],
      terrain: [...(map.terrain || []), ...c.terrain],
      openable: c.openable,
      teleporters: c.teleporters,
    };
  }

  // Hit-test a point against a piece (for the editor erase tool).
  function pieceHit(p, px, py) {
    const def = PIECES[p.kind];
    if (!def) return false;
    if (def.type === 'wall') {
      const seg = pieceWallSegment(p);
      return pointSegDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2) <= 0.6;
    }
    if (def.type === 'wallend') {
      return Math.hypot(px - p.x, py - p.y) <= 0.9;
    }
    if (def.type === 'circle') {
      return Math.hypot(px - p.x, py - p.y) <= def.r;
    }
    const t = pieceTerrainShape(p);
    return Math.abs(px - t.x) <= t.w / 2 && Math.abs(py - t.y) <= t.h / 2;
  }

  // --- Piece drawing ------------------------------------------------------
  // Canvas renderer used by the editor and the game board. (sx, sy) are the
  // px-per-inch scale factors for x and y.

  const PIECE_COLORS = {
    wall: '#0a0706',
    breach: '#c97a3a',
    hatchway: '#7a9c3e',
    necron: '#48b04a',
    wallend: '#1f4d36',
    sarcophagus: '#0a0706',
    rect: '#0a0706',
    teleport: '#0a0706',
    teleportRing: '#7a9c3e',
  };

  function squashedHexPath(ctx, cx, cy, w, h, axisRotRad) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(axisRotRad);
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(-w / 4, -h / 2);
    ctx.lineTo(w / 4, -h / 2);
    ctx.lineTo(w / 2, 0);
    ctx.lineTo(w / 4, h / 2);
    ctx.lineTo(-w / 4, h / 2);
    ctx.closePath();
    ctx.restore();
  }

  function drawWallPiece(ctx, p, def, sx, sy) {
    const rot = ((p.rot || 0) % 4 + 4) % 4;
    const flip = !!p.flip;
    const [dx, dy] = rotDir(rot);
    const x1 = p.x * sx, y1 = p.y * sy;
    const x2 = (p.x + dx * def.len) * sx, y2 = (p.y + dy * def.len) * sy;

    // Main wall line
    ctx.strokeStyle = PIECE_COLORS.wall;
    ctx.lineWidth = Math.max(3, Math.min(sx, sy) * 0.32);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // End caps — 1" filled squares (same size as C4/C5) at each endpoint.
    const capX = 1.0 * sx, capY = 1.0 * sy;
    ctx.fillStyle = PIECE_COLORS.wall;
    ctx.fillRect(x1 - capX / 2, y1 - capY / 2, capX, capY);
    ctx.fillRect(x2 - capX / 2, y2 - capY / 2, capX, capY);

    if (!def.marker) return;

    const angle = Math.atan2(y2 - y1, x2 - x1); // along-wall direction (radians)
    const perp = angle + Math.PI / 2;
    const inch = Math.min(sx, sy);

    // Marker placement in inches along the wall (from anchor) and perp offset.
    let alongIn = def.len / 2; // default centred
    let perpIn = 0;
    if (def.asymm === 'half') {
      alongIn = flip ? def.len * 0.75 : def.len * 0.25;
    } else if (def.asymm === 'side') {
      alongIn = def.len / 2;
      perpIn = flip ? -0.55 : 0.55;
    }
    const cx = (p.x + dx * alongIn) * sx + Math.cos(perp) * perpIn * inch;
    const cy = (p.y + dy * alongIn) * sy + Math.sin(perp) * perpIn * inch;

    if (def.marker === 'breach' || def.marker === 'hatchway') {
      const fill = def.marker === 'breach' ? PIECE_COLORS.breach : PIECE_COLORS.hatchway;
      // Squashed hex marker — ~3/4 of a 4" grid square long.
      const w = 3.0 * inch, h = 0.8 * inch;
      squashedHexPath(ctx, cx, cy, w, h, angle);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = '#0a0706';
      ctx.lineWidth = 1;
      squashedHexPath(ctx, cx, cy, w, h, angle);
      ctx.stroke();
    } else if (def.marker === 'necron') {
      // 3 small green squares along ONE side of the wall
      const sideSign = flip ? -1 : 1;
      const offset = 0.5 * inch * sideSign;
      const sq = 0.35 * inch;
      for (let i = 0; i < 3; i++) {
        const t = (i + 1) / 4; // 1/4, 2/4, 3/4 along wall
        const ax = (p.x + dx * def.len * t) * sx + Math.cos(perp) * offset;
        const ay = (p.y + dy * def.len * t) * sy + Math.sin(perp) * offset;
        ctx.fillStyle = PIECE_COLORS.necron;
        ctx.fillRect(ax - sq / 2, ay - sq / 2, sq, sq);
      }
    }
  }

  function drawWallEndPiece(ctx, p, sx, sy) {
    const inch = Math.min(sx, sy);
    const cx = p.x * sx, cy = p.y * sy;
    const r = 0.6 * inch;
    ctx.fillStyle = PIECE_COLORS.wallend;
    ctx.strokeStyle = '#0a0706';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // small "X" cross in centre
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.45, cy - r * 0.45);
    ctx.lineTo(cx + r * 0.45, cy + r * 0.45);
    ctx.moveTo(cx - r * 0.45, cy + r * 0.45);
    ctx.lineTo(cx + r * 0.45, cy - r * 0.45);
    ctx.stroke();
  }

  function drawCirclePiece(ctx, p, def, sx, sy) {
    const inch = Math.min(sx, sy);
    const cx = p.x * sx, cy = p.y * sy;
    const r = def.r * inch;
    ctx.fillStyle = PIECE_COLORS.teleport;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = PIECE_COLORS.teleportRing;
    ctx.lineWidth = Math.max(1, inch * 0.08);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
    ctx.stroke();
    if (def.label) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(0.7 * inch)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.label, cx, cy);
    }
  }

  function drawRectPiece(ctx, p, def, sx, sy) {
    const inch = Math.min(sx, sy);
    const horiz = ((p.rot || 0) & 1) === 0;
    const w = (horiz ? def.w : def.h) * sx;
    const h = (horiz ? def.h : def.w) * sy;
    const x = p.x * sx - w / 2;
    const y = p.y * sy - h / 2;

    if (def.type === 'sarcophagus') {
      const r = Math.min(w, h) * 0.22; // shaved corners
      ctx.fillStyle = PIECE_COLORS.sarcophagus;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.lineTo(x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.lineTo(x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.lineTo(x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = PIECE_COLORS.rect;
      ctx.fillRect(x, y, w, h);
    }

    if (def.label) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(0.55 * inch)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.label, p.x * sx, p.y * sy);
    }
  }

  function drawPieceCanvas(ctx, p, sx, sy) {
    const def = PIECES[p.kind];
    if (!def) return;
    if (def.type === 'wall')        drawWallPiece(ctx, p, def, sx, sy);
    else if (def.type === 'wallend') drawWallEndPiece(ctx, p, sx, sy);
    else if (def.type === 'circle')  drawCirclePiece(ctx, p, def, sx, sy);
    else if (def.type === 'rect' || def.type === 'sarcophagus') drawRectPiece(ctx, p, def, sx, sy);
  }

  function loadCustomMaps() {
    try {
      const raw = localStorage.getItem('kt.customMaps');
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (e) {
      return {};
    }
  }

  function saveCustomMap(map) {
    const all = loadCustomMaps();
    all[map.id] = map;
    localStorage.setItem('kt.customMaps', JSON.stringify(all));
  }

  function deleteCustomMap(id) {
    const all = loadCustomMaps();
    delete all[id];
    localStorage.setItem('kt.customMaps', JSON.stringify(all));
  }

  function getMap(id) {
    if (TOMB_MAPS[id]) return TOMB_MAPS[id];
    const custom = loadCustomMaps();
    if (custom[id]) return custom[id];
    return null;
  }

  function allMaps() {
    return { ...TOMB_MAPS, ...loadCustomMaps() };
  }

  root.KT = root.KT || {};
  root.KT.TOMB_BOARD = TOMB_BOARD;
  root.KT.TOMB_MAPS = TOMB_MAPS;
  root.KT.geom = { dist, segIntersect, pointSegDist, losBlocked, moveBlocked };
  root.KT.deployZone = deployZone;
  root.KT.inDeployZone = inDeployZone;
  root.KT.deploySquares = deploySquares;
  root.KT.inDeploySquare = inDeploySquare;
  root.KT.perimeter = perimeter;
  root.KT.room = room;
  root.KT.loadCustomMaps = loadCustomMaps;
  root.KT.saveCustomMap = saveCustomMap;
  root.KT.deleteCustomMap = deleteCustomMap;
  root.KT.getMap = getMap;
  root.KT.allMaps = allMaps;
  root.KT.PIECES = PIECES;
  root.KT.PIECE_KINDS = PIECE_KINDS;
  root.KT.rotDir = rotDir;
  root.KT.pieceWallSegment = pieceWallSegment;
  root.KT.pieceTerrainShape = pieceTerrainShape;
  root.KT.compilePieces = compilePieces;
  root.KT.compileMap = compileMap;
  root.KT.pieceHit = pieceHit;
  root.KT.drawPieceCanvas = drawPieceCanvas;
})(typeof window !== 'undefined' ? window : globalThis);
