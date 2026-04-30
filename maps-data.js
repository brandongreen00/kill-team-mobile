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
  root.KT.perimeter = perimeter;
  root.KT.room = room;
  root.KT.loadCustomMaps = loadCustomMaps;
  root.KT.saveCustomMap = saveCustomMap;
  root.KT.deleteCustomMap = deleteCustomMap;
  root.KT.getMap = getMap;
  root.KT.allMaps = allMaps;
})(typeof window !== 'undefined' ? window : globalThis);
