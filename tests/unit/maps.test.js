// Unit tests for maps-data.js — board geometry, deployment zones, the room
// helper, the piece-based map model, and custom-map persistence.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./load');

const env = setup();
const KT = env.KT;

test('TOMB_BOARD reports the standard 28x24 grid', () => {
  assert.equal(KT.TOMB_BOARD.width, 28);
  assert.equal(KT.TOMB_BOARD.height, 24);
  assert.equal(KT.TOMB_BOARD.gridSize, 4);
});

test('Every TOMB map can be compiled and exposes walls + objectives', () => {
  for (const [id, raw] of Object.entries(KT.TOMB_MAPS)) {
    const map = KT.compileMap(raw);
    assert.ok(Array.isArray(map.walls), `${id}: walls`);
    assert.ok(Array.isArray(map.terrain), `${id}: terrain`);
    assert.ok(Array.isArray(map.objectives), `${id}: objectives`);
    assert.ok(map.objectives.length >= 1, `${id}: at least one objective`);
    for (const o of map.objectives) {
      assert.ok(['A', 'B', 'neutral'].includes(o.owner), `${id}: objective owner`);
    }
  }
});

test('deployZone splits the board cleanly along the axis declared by the map', () => {
  const v = KT.deployZone({ split: 'vertical' }, 'A');
  assert.deepEqual(v, { x: 0, y: 0, w: 14, h: 24 });
  const vB = KT.deployZone({ split: 'vertical' }, 'B');
  assert.deepEqual(vB, { x: 14, y: 0, w: 14, h: 24 });

  const h = KT.deployZone({ split: 'horizontal' }, 'A');
  assert.deepEqual(h, { x: 0, y: 12, w: 28, h: 12 });
  const hB = KT.deployZone({ split: 'horizontal' }, 'B');
  assert.deepEqual(hB, { x: 0, y: 0, w: 28, h: 12 });
});

test('inDeploySquare uses explicit deploy zones when present, otherwise the half', () => {
  const map = {
    split: 'vertical',
    deployZones: [
      { team: 'A', x: 0, y: 0, w: 4, h: 4 },
      { team: 'A', x: 0, y: 8, w: 4, h: 4 },
    ],
  };
  assert.equal(KT.inDeploySquare(map, 'A', 2, 2), true);   // inside square
  assert.equal(KT.inDeploySquare(map, 'A', 2, 6), false);  // gap between squares
  assert.equal(KT.inDeploySquare(map, 'A', 2, 10), true);  // second square
  // Team B has no explicit squares → falls back to its half.
  assert.equal(KT.inDeploySquare(map, 'B', 20, 2), true);
  assert.equal(KT.inDeploySquare(map, 'B', 5, 2),  false);
});

test('room() emits a rectangle with door gaps removed from the requested side', () => {
  // 4x4 room with a 2"-wide door centred on the bottom edge.
  const segs = KT.room(0, 0, 4, 4, [{ side: 'bottom', at: 1, span: 2 }]);
  // Top + left + right are continuous; bottom splits into [0..1] and [3..4].
  const horizontalsAtY4 = segs.filter(s => s.y1 === 4 && s.y2 === 4);
  assert.equal(horizontalsAtY4.length, 2);
  const lengths = horizontalsAtY4
    .map(s => Math.abs(s.x2 - s.x1))
    .sort((a, b) => a - b);
  assert.deepEqual(lengths, [1, 1]);
});

test('compilePieces splits hatchway / breach walls into flank + openable spans', () => {
  const piece = { kind: 'A1', x: 4, y: 4, rot: 0 }; // 8" wall, breach
  const out = KT.compilePieces([piece]);
  // Three segments expected: lo flank, openable span, hi flank.
  assert.equal(out.walls.length, 3);
  const openable = out.walls.find(w => w.role === 'openable');
  assert.ok(openable);
  assert.equal(openable.pieceIndex, 0);
  // Flanks must have null pieceIndex so they always block.
  for (const w of out.walls.filter(w => w.role !== 'openable')) {
    assert.equal(w.pieceIndex, null);
  }
  // openable list should describe the same piece.
  assert.equal(out.openable.length, 1);
  assert.equal(out.openable[0].kind, 'breach');
});

test('compilePieces produces a plain wall segment for non-openable wall pieces', () => {
  const piece = { kind: 'B1', x: 0, y: 0, rot: 0 }; // 4" plain wall
  const out = KT.compilePieces([piece]);
  assert.equal(out.walls.length, 1);
  assert.equal(out.walls[0].role, 'wall');
  assert.equal(out.walls[0].x1, 0);
  assert.equal(out.walls[0].x2, 4);
});

test('compileMap merges wall arrays from both legacy and piece sources', () => {
  const raw = {
    walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }],
    pieces: [{ kind: 'B1', x: 5, y: 5, rot: 0 }],
  };
  const compiled = KT.compileMap(raw);
  assert.equal(compiled.walls.length, 2);
  assert.equal(compiled.openable.length, 0);
});

test('rotDir cycles through right / down / left / up', () => {
  assert.deepEqual(KT.rotDir(0), [1, 0]);
  assert.deepEqual(KT.rotDir(1), [0, 1]);
  assert.deepEqual(KT.rotDir(2), [-1, 0]);
  assert.deepEqual(KT.rotDir(3), [0, -1]);
  // Out-of-range values wrap.
  assert.deepEqual(KT.rotDir(5), [0, 1]);
  assert.deepEqual(KT.rotDir(-1), [0, -1]);
});

test('saveCustomMap / loadCustomMaps / deleteCustomMap round-trip through localStorage', () => {
  env.resetStorage();
  assert.deepEqual(KT.loadCustomMaps(), {});
  KT.saveCustomMap({ id: 'kt-test-1', name: 'Test', split: 'vertical', pieces: [] });
  const all = KT.loadCustomMaps();
  assert.ok(all['kt-test-1']);
  assert.equal(all['kt-test-1'].name, 'Test');
  assert.equal(KT.getMap('kt-test-1').name, 'Test');
  KT.deleteCustomMap('kt-test-1');
  assert.deepEqual(KT.loadCustomMaps(), {});
});

test('allMaps unions built-in and custom maps', () => {
  env.resetStorage();
  KT.saveCustomMap({ id: 'kt-test-2', name: 'Foo', split: 'horizontal', pieces: [] });
  const all = KT.allMaps();
  assert.ok(all['tomb-1'], 'built-in still present');
  assert.ok(all['kt-test-2'], 'custom present');
  env.resetStorage();
});

test('pieceWallSegment derives endpoints from anchor + rotation', () => {
  const seg = KT.pieceWallSegment({ kind: 'B1', x: 2, y: 3, rot: 1 });
  assert.equal(seg.x1, 2);
  assert.equal(seg.y1, 3);
  assert.equal(seg.x2, 2);
  assert.equal(seg.y2, 7); // rot=1 → down 4"
});

test('pieceTerrainShape: rect rotates dimensions for vertical orientation', () => {
  // C2 is 2.4 × 2.0; rot=1 swaps to 2.0 × 2.4 (long axis vertical).
  const horiz = KT.pieceTerrainShape({ kind: 'C2', x: 5, y: 5, rot: 0 });
  const vert  = KT.pieceTerrainShape({ kind: 'C2', x: 5, y: 5, rot: 1 });
  assert.equal(horiz.w, 2.4);
  assert.equal(horiz.h, 2.0);
  assert.equal(vert.w,  2.0);
  assert.equal(vert.h,  2.4);
  assert.equal(horiz.cover, 'debris');
});
