(() => {
  const KT = window.KT;
  const canvas = document.getElementById('creator');
  const ctx = canvas.getContext('2d');
  const help = document.getElementById('creator-help');

  const nameInput = document.getElementById('map-name');
  const splitInput = document.getElementById('map-split');
  const sizeInput = document.getElementById('map-size');
  const snapInput = document.getElementById('snap');
  const objectiveTools = document.getElementById('objective-tools');
  const objOwnerInput = document.getElementById('obj-owner');
  const layerSummary = document.getElementById('layer-summary');
  const loadSelect = document.getElementById('load-map');
  const piecePicker = document.getElementById('piece-picker');
  const advancedToggle = document.getElementById('advanced-toggle');
  const saveNotice = document.getElementById('save-notice');
  const placementActions = document.getElementById('placement-actions');
  const placementStatus = document.getElementById('placement-status');
  const placeBtn = document.getElementById('place-btn');
  const cancelPlaceBtn = document.getElementById('cancel-place-btn');
  const flipBtn = document.getElementById('flip-btn');
  const rotCwBtn = document.getElementById('rot-cw-btn');
  const rotCcwBtn = document.getElementById('rot-ccw-btn');

  let board = { width: 28, height: 24, gridSize: 4 };
  let map = blankMap();
  let tool = 'piece';
  let pendingWall = null;        // legacy freeform wall tool first-click
  let hoverPt = null;            // snapped board-space point under cursor (mouse)
  let tentativePt = null;        // touch-friendly explicit ghost position
  let pieceKind = 'A1';          // currently selected piece kind
  let pieceRot = 0;              // 0..3
  let pieceFlip = false;
  let advanced = false;

  function blankMap() {
    return {
      id: 'custom-' + Date.now().toString(36),
      name: 'Untitled',
      desc: '',
      split: 'vertical',
      walls: [],
      doors: [],
      terrain: [],
      objectives: [],
      pieces: [],
      custom: true,
    };
  }

  function setBoardFromSize(value) {
    if (value === '22x30') board = { width: 22, height: 30, gridSize: 4 };
    else board = { width: 28, height: 24, gridSize: 4 };
  }

  // --- Coordinate transforms --------------------------------------------

  function eventToBoard(evt) {
    const rect = canvas.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * board.width;
    const y = ((evt.clientY - rect.top) / rect.height) * board.height;
    return { x, y };
  }

  function snapVal(v) {
    const s = parseFloat(snapInput.value);
    return Math.round(v / s) * s;
  }

  function snapPoint(p) {
    return { x: snapVal(p.x), y: snapVal(p.y) };
  }

  // --- Drawing ----------------------------------------------------------

  function fitCanvas() {
    const wrap = canvas.parentElement;
    const w = wrap.clientWidth;
    const aspect = board.width / board.height;
    const h = w / aspect;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = w * devicePixelRatio;
    canvas.height = h * devicePixelRatio;
  }

  function draw() {
    fitCanvas();
    const W = canvas.width, H = canvas.height;
    const sx = W / board.width;
    const sy = H / board.height;

    ctx.fillStyle = '#1a1714';
    ctx.fillRect(0, 0, W, H);

    // deployment fills
    const aZone = KT.deployZone(map, 'A');
    const bZone = KT.deployZone(map, 'B');
    ctx.fillStyle = 'rgba(233, 176, 122, 0.35)';
    ctx.fillRect(aZone.x * sx, aZone.y * sy, aZone.w * sx, aZone.h * sy);
    ctx.fillStyle = 'rgba(157, 160, 168, 0.30)';
    ctx.fillRect(bZone.x * sx, bZone.y * sy, bZone.w * sx, bZone.h * sy);

    // major grid lines (4")
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= board.width; x += board.gridSize) {
      ctx.beginPath();
      ctx.moveTo(x * sx, 0); ctx.lineTo(x * sx, H);
      ctx.stroke();
    }
    for (let y = 0; y <= board.height; y += board.gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y * sy); ctx.lineTo(W, y * sy);
      ctx.stroke();
    }

    // sub-grid (1") — only if snap is finer than 4"
    if (parseFloat(snapInput.value) < 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.025)';
      for (let x = 0; x <= board.width; x++) {
        if (x % board.gridSize === 0) continue;
        ctx.beginPath();
        ctx.moveTo(x * sx, 0); ctx.lineTo(x * sx, H);
        ctx.stroke();
      }
      for (let y = 0; y <= board.height; y++) {
        if (y % board.gridSize === 0) continue;
        ctx.beginPath();
        ctx.moveTo(0, y * sy); ctx.lineTo(W, y * sy);
        ctx.stroke();
      }
    }

    // deployment divider dashed
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (map.split === 'vertical') {
      ctx.moveTo((board.width / 2) * sx, 0);
      ctx.lineTo((board.width / 2) * sx, H);
    } else {
      ctx.moveTo(0, (board.height / 2) * sy);
      ctx.lineTo(W, (board.height / 2) * sy);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // perimeter
    ctx.strokeStyle = '#0a0706';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, W, H);

    // legacy walls (if any)
    for (const w of map.walls || []) {
      ctx.strokeStyle = '#0a0706';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(w.x1 * sx, w.y1 * sy);
      ctx.lineTo(w.x2 * sx, w.y2 * sy);
      ctx.stroke();
    }

    // legacy terrain
    for (const t of map.terrain || []) drawLegacyTerrain(t, sx, sy);

    // pieces
    for (const p of map.pieces || []) KT.drawPieceCanvas(ctx, p, sx, sy);

    // ghost preview (piece tool) — tentative point wins over hover
    if (tool === 'piece') {
      const previewPt = tentativePt || hoverPt;
      if (previewPt) {
        ctx.save();
        ctx.globalAlpha = tentativePt ? 0.8 : 0.55;
        KT.drawPieceCanvas(ctx, { kind: pieceKind, x: previewPt.x, y: previewPt.y, rot: pieceRot, flip: pieceFlip }, sx, sy);
        ctx.restore();
        if (tentativePt) {
          ctx.strokeStyle = 'rgba(201,167,77,0.9)';
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(tentativePt.x * sx, tentativePt.y * sy, Math.max(sx, sy) * 1.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // pending freeform wall preview
    if (pendingWall && hoverPt) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(201,167,77,0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pendingWall.x * sx, pendingWall.y * sy);
      ctx.lineTo(hoverPt.x * sx, hoverPt.y * sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // objectives
    for (const o of map.objectives) {
      const fill = o.owner === 'A' ? '#b8203a' : (o.owner === 'B' ? '#fff' : '#0a0706');
      const ring = o.owner === 'A' ? '#fff' : (o.owner === 'B' ? '#0a0706' : '#fff');
      ctx.fillStyle = fill;
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(o.x * sx, o.y * sy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // hover crosshair (when not piece-mode, since piece-mode shows ghost)
    if (hoverPt && tool !== 'piece') {
      const hx = hoverPt.x * sx, hy = hoverPt.y * sy;
      ctx.strokeStyle = 'rgba(201,167,77,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx - 8, hy); ctx.lineTo(hx + 8, hy);
      ctx.moveTo(hx, hy - 8); ctx.lineTo(hx, hy + 8);
      ctx.stroke();
    }
  }

  function drawLegacyTerrain(t, sx, sy) {
    ctx.fillStyle = '#0a0706';
    ctx.strokeStyle = '#3a302a';
    if (t.type === 'octagon') {
      const cx = t.x * sx, cy = t.y * sy, r = (t.r || 2) * Math.min(sx, sy);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + i * Math.PI / 4;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    } else if (t.type === 'circle') {
      ctx.beginPath();
      ctx.arc(t.x * sx, t.y * sy, (t.r || 1.5) * Math.min(sx, sy), 0, Math.PI * 2);
      ctx.fill();
      if (t.label) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(0.7 * Math.min(sx, sy))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(t.label, t.x * sx, t.y * sy);
      }
    } else if (t.type === 'square') {
      const s = (t.size || 2) * Math.min(sx, sy);
      ctx.fillRect(t.x * sx - s / 2, t.y * sy - s / 2, s, s);
      if (t.label) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(0.6 * Math.min(sx, sy))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(t.label, t.x * sx, t.y * sy);
      }
    } else if (t.type === 'barricade') {
      ctx.lineWidth = 2;
      ctx.strokeRect(t.x * sx, t.y * sy, t.w * sx, t.h * sy);
    } else if (t.type === 'rect' || t.type === 'sarcophagus') {
      const w = t.w * sx, h = t.h * sy;
      ctx.fillRect(t.x * sx - w / 2, t.y * sy - h / 2, w, h);
      if (t.label) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(0.55 * Math.min(sx, sy))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(t.label, t.x * sx, t.y * sy);
      }
    }
  }

  // --- Tool handlers ----------------------------------------------------

  function setTool(t) {
    tool = t;
    pendingWall = null;
    tentativePt = null;
    document.querySelectorAll('.btn-tool').forEach(b => {
      if (!b.dataset.tool) return;
      b.classList.toggle('active', b.dataset.tool === t);
    });
    piecePicker.style.display = (t === 'piece') ? '' : 'none';
    objectiveTools.style.display = (t === 'objective') ? '' : 'none';
    placementActions.style.display = (t === 'piece') ? '' : 'none';
    // Mobile CSS adds bottom padding to body so the fixed action bar
    // never covers the Save / Back buttons. Only apply it when the bar
    // is actually showing.
    document.body.classList.toggle('has-fixed-placement', t === 'piece');
    updateHelp();
    updatePlacementStatus();
    draw();
  }

  function updateHelp() {
    const tips = {
      select: 'Select tool — click to inspect. (No-op)',
      piece: `Pieces — placing ${pieceKind}. Scroll to rotate (${pieceRot * 90}°), right-click to flip side${pieceFlip ? ' (flipped)' : ''}, click to place. Snap ${snapInput.value}".`,
      wall: 'Wall tool (advanced) — click two points to place a freeform wall segment. Snaps to ' + snapInput.value + '".',
      objective: 'Objective tool — click to place an objective marker.',
      erase: 'Erase tool — click on a piece, wall, terrain, or objective to remove it.',
    };
    help.textContent = tips[tool] || '';
  }

  function setPieceKind(kind) {
    pieceKind = kind;
    document.querySelectorAll('.piece-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.kind === kind);
    });
    updateHelp();
    updatePlacementStatus();
    draw();
  }

  function rotatePiece(delta) {
    pieceRot = ((pieceRot + delta) % 4 + 4) % 4;
    updateHelp();
    updatePlacementStatus();
    draw();
  }

  function flipPiece() {
    pieceFlip = !pieceFlip;
    updateHelp();
    updatePlacementStatus();
    draw();
  }

  function commitTentativePiece() {
    if (!tentativePt) return;
    map.pieces = map.pieces || [];
    map.pieces.push({
      kind: pieceKind,
      x: tentativePt.x,
      y: tentativePt.y,
      rot: pieceRot,
      flip: pieceFlip,
    });
    tentativePt = null;
    refreshSummary();
    updatePlacementStatus();
    draw();
  }

  function clearTentativePiece() {
    tentativePt = null;
    updatePlacementStatus();
    draw();
  }

  function updatePlacementStatus() {
    if (tool !== 'piece') return;
    const has = !!tentativePt;
    placeBtn.disabled = !has;
    cancelPlaceBtn.disabled = !has;
    placementStatus.classList.toggle('has-tentative', has);
    const rotDeg = pieceRot * 90;
    const flipNote = pieceFlip ? ' · flipped' : '';
    if (has) {
      placementStatus.textContent =
        `${pieceKind} @ ${tentativePt.x.toFixed(1)}″, ${tentativePt.y.toFixed(1)}″ · ${rotDeg}°${flipNote}`;
    } else {
      placementStatus.textContent =
        `${pieceKind} · ${rotDeg}°${flipNote} — tap board to position, then Place`;
    }
  }

  function nearestErase(p) {
    // Pieces (highest priority — drawn on top)
    for (let i = (map.pieces || []).length - 1; i >= 0; i--) {
      if (KT.pieceHit(map.pieces[i], p.x, p.y)) return { kind: 'piece', index: i };
    }
    for (let i = map.walls.length - 1; i >= 0; i--) {
      const w = map.walls[i];
      const d = KT.geom.pointSegDist(p.x, p.y, w.x1, w.y1, w.x2, w.y2);
      if (d <= 0.6) return { kind: 'wall', index: i };
    }
    for (let i = map.terrain.length - 1; i >= 0; i--) {
      const t = map.terrain[i];
      let d;
      if (t.type === 'barricade') {
        d = KT.geom.pointSegDist(p.x, p.y, t.x, t.y, t.x + t.w, t.y + t.h);
      } else if (t.type === 'rect' || t.type === 'sarcophagus') {
        d = Math.max(Math.abs(p.x - t.x) - t.w / 2, Math.abs(p.y - t.y) - t.h / 2, 0);
      } else {
        d = Math.hypot(p.x - t.x, p.y - t.y);
      }
      if (d <= (t.r || t.size || 2)) return { kind: 'terrain', index: i };
    }
    for (let i = map.objectives.length - 1; i >= 0; i--) {
      const o = map.objectives[i];
      const d = Math.hypot(p.x - o.x, p.y - o.y);
      if (d <= 1.0) return { kind: 'objective', index: i };
    }
    return null;
  }

  // --- Canvas events ----------------------------------------------------

  canvas.addEventListener('mousemove', (evt) => {
    const p = eventToBoard(evt);
    hoverPt = snapPoint(p);
    draw();
  });

  canvas.addEventListener('mouseleave', () => { hoverPt = null; draw(); });

  // Disable native context menu so right-click can flip pieces.
  canvas.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    if (tool === 'piece') flipPiece();
  });

  canvas.addEventListener('wheel', (evt) => {
    if (tool !== 'piece') return;
    evt.preventDefault();
    rotatePiece(evt.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  canvas.addEventListener('click', (evt) => {
    // Touch generates a synthetic click on tap-end — ignore it so we don't
    // double-place the piece on phones (the touch handler already managed it).
    if (lastTouchHandledAt && (Date.now() - lastTouchHandledAt) < 500) return;
    const p = eventToBoard(evt);
    const sp = snapPoint(p);
    if (tool === 'piece') {
      map.pieces = map.pieces || [];
      map.pieces.push({ kind: pieceKind, x: sp.x, y: sp.y, rot: pieceRot, flip: pieceFlip });
      tentativePt = null;
      updatePlacementStatus();
    } else if (tool === 'wall') {
      if (!pendingWall) {
        pendingWall = sp;
      } else {
        if (sp.x !== pendingWall.x || sp.y !== pendingWall.y) {
          map.walls.push({ x1: pendingWall.x, y1: pendingWall.y, x2: sp.x, y2: sp.y });
        }
        pendingWall = null;
      }
    } else if (tool === 'objective') {
      map.objectives.push({ x: sp.x, y: sp.y, owner: objOwnerInput.value });
    } else if (tool === 'erase') {
      const hit = nearestErase(p);
      if (hit) {
        if (hit.kind === 'piece') map.pieces.splice(hit.index, 1);
        else if (hit.kind === 'wall') map.walls.splice(hit.index, 1);
        else if (hit.kind === 'terrain') map.terrain.splice(hit.index, 1);
        else if (hit.kind === 'objective') map.objectives.splice(hit.index, 1);
      }
    }
    refreshSummary();
    draw();
  });

  // --- Touch input ------------------------------------------------------
  // On phones there is no hover, scroll wheel, or right-click. Touching the
  // board sets a *tentative* placement that the user then commits with the
  // explicit Place button (and adjusts via Rotate / Flip).

  let lastTouchHandledAt = 0;
  let touchActive = false;

  function touchToBoard(touch) {
    const rect = canvas.getBoundingClientRect();
    const x = ((touch.clientX - rect.left) / rect.width) * board.width;
    const y = ((touch.clientY - rect.top) / rect.height) * board.height;
    return { x, y };
  }

  canvas.addEventListener('touchstart', (evt) => {
    if (evt.touches.length !== 1) return;
    evt.preventDefault();
    touchActive = true;
    lastTouchHandledAt = Date.now();
    const t = evt.touches[0];
    const p = touchToBoard(t);
    const sp = snapPoint(p);
    if (tool === 'piece') {
      tentativePt = sp;
      hoverPt = sp;
      updatePlacementStatus();
    } else if (tool === 'objective') {
      map.objectives.push({ x: sp.x, y: sp.y, owner: objOwnerInput.value });
      refreshSummary();
    } else if (tool === 'erase') {
      const hit = nearestErase(p);
      if (hit) {
        if (hit.kind === 'piece') map.pieces.splice(hit.index, 1);
        else if (hit.kind === 'wall') map.walls.splice(hit.index, 1);
        else if (hit.kind === 'terrain') map.terrain.splice(hit.index, 1);
        else if (hit.kind === 'objective') map.objectives.splice(hit.index, 1);
        refreshSummary();
      }
    } else if (tool === 'wall') {
      if (!pendingWall) {
        pendingWall = sp;
      } else {
        if (sp.x !== pendingWall.x || sp.y !== pendingWall.y) {
          map.walls.push({ x1: pendingWall.x, y1: pendingWall.y, x2: sp.x, y2: sp.y });
        }
        pendingWall = null;
      }
    }
    draw();
  }, { passive: false });

  canvas.addEventListener('touchmove', (evt) => {
    if (!touchActive || evt.touches.length !== 1) return;
    evt.preventDefault();
    lastTouchHandledAt = Date.now();
    if (tool !== 'piece') return;
    const sp = snapPoint(touchToBoard(evt.touches[0]));
    tentativePt = sp;
    hoverPt = sp;
    updatePlacementStatus();
    draw();
  }, { passive: false });

  canvas.addEventListener('touchend', (evt) => {
    if (!touchActive) return;
    evt.preventDefault();
    touchActive = false;
    lastTouchHandledAt = Date.now();
    // Drop the lingering hoverPt so we don't render a phantom desktop ghost.
    hoverPt = null;
    draw();
  }, { passive: false });

  canvas.addEventListener('touchcancel', () => {
    touchActive = false;
    hoverPt = null;
    draw();
  });

  // --- Placement action buttons ---------------------------------------

  rotCcwBtn.addEventListener('click', () => rotatePiece(-1));
  rotCwBtn.addEventListener('click', () => rotatePiece(1));
  flipBtn.addEventListener('click', flipPiece);
  placeBtn.addEventListener('click', commitTentativePiece);
  cancelPlaceBtn.addEventListener('click', clearTentativePiece);

  // --- Sidebar / persistence -------------------------------------------

  function refreshSummary() {
    layerSummary.innerHTML = '';
    function row(label, n) {
      const p = document.createElement('p');
      p.className = 'entry';
      p.textContent = `${label}: ${n}`;
      layerSummary.appendChild(p);
    }
    const pieceCount = (map.pieces || []).length;
    const tCount = (map.pieces || []).filter(p => p.kind === 'T').length;
    row('Pieces', pieceCount);
    row('Teleport pads', tCount);
    if ((map.walls || []).length) row('Legacy walls', map.walls.length);
    if ((map.terrain || []).length) row('Legacy terrain', map.terrain.length);
    row('Objectives', map.objectives.length);
  }

  function refreshLoadList() {
    loadSelect.innerHTML = '<option value="">— New blank map —</option>';
    Object.values(KT.TOMB_MAPS).forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = '[Tomb] ' + m.name;
      loadSelect.appendChild(o);
    });
    Object.values(KT.loadCustomMaps()).forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = '[Custom] ' + m.name;
      loadSelect.appendChild(o);
    });
  }

  function applyMapToInputs() {
    nameInput.value = map.name || '';
    splitInput.value = map.split || 'vertical';
    sizeInput.value = (board.width === 22) ? '22x30' : '28x24';
  }

  function showNotice(msg, kind = 'warn') {
    saveNotice.textContent = msg;
    saveNotice.style.display = '';
    saveNotice.style.borderColor = kind === 'ok' ? '#3a5a2a' : 'var(--warn-border)';
    saveNotice.style.color = kind === 'ok' ? '#a4d68b' : 'var(--warn)';
    saveNotice.style.background = kind === 'ok' ? 'rgba(120, 200, 120, 0.06)' : 'rgba(230, 138, 106, 0.08)';
  }

  function clearNoticeSoon() {
    setTimeout(() => { saveNotice.style.display = 'none'; }, 4000);
  }

  loadSelect.addEventListener('change', () => {
    const id = loadSelect.value;
    if (!id) {
      map = blankMap();
    } else {
      const found = KT.getMap(id);
      if (found) {
        map = JSON.parse(JSON.stringify(found));
        if (!map.id || !map.id.startsWith('custom-')) {
          map.id = 'custom-' + Date.now().toString(36);
          map.name = (map.name || 'Map') + ' (copy)';
          map.custom = true;
        }
        map.pieces = map.pieces || [];
      }
    }
    applyMapToInputs();
    refreshSummary();
    draw();
  });

  document.getElementById('save-btn').addEventListener('click', () => {
    map.name = nameInput.value.trim() || 'Untitled';
    map.split = splitInput.value;
    map.custom = true;
    if (!map.id.startsWith('custom-')) map.id = 'custom-' + Date.now().toString(36);
    KT.saveCustomMap(map);
    refreshLoadList();
    loadSelect.value = map.id;

    const tCount = (map.pieces || []).filter(p => p.kind === 'T').length;
    if (tCount !== 2) {
      showNotice(`Saved "${map.name}". Note: this map has ${tCount} teleport pad${tCount === 1 ? '' : 's'} — every tomb-world map should carry exactly 2 (T).`, 'warn');
    } else {
      showNotice(`Saved "${map.name}".`, 'ok');
      clearNoticeSoon();
    }
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const json = JSON.stringify(map, null, 2);
    navigator.clipboard?.writeText(json);
    const w = window.open('', '_blank');
    if (w) {
      w.document.write('<pre style="font-family:monospace;padding:16px;white-space:pre-wrap;">' + json.replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>');
    }
  });

  document.getElementById('import-btn').addEventListener('click', () => {
    const raw = prompt('Paste map JSON:');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      map = parsed;
      map.custom = true;
      map.pieces = map.pieces || [];
      if (!map.id) map.id = 'custom-' + Date.now().toString(36);
      applyMapToInputs();
      refreshSummary();
      draw();
    } catch (e) { alert('Invalid JSON: ' + e.message); }
  });

  document.getElementById('delete-btn').addEventListener('click', () => {
    if (!map.id.startsWith('custom-')) { alert('Built-in tomb maps cannot be deleted.'); return; }
    if (!confirm('Delete "' + map.name + '"?')) return;
    KT.deleteCustomMap(map.id);
    map = blankMap();
    applyMapToInputs();
    refreshSummary();
    refreshLoadList();
    loadSelect.value = '';
    draw();
  });

  // Tool buttons — only the toolbar entries (Select / Pieces / Objective /
  // Erase / Wall) carry data-tool. The placement-action buttons share the
  // .btn-tool class for styling but must NOT swap tool, so scope by attribute.
  document.querySelectorAll('.btn-tool[data-tool]').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  // Piece picker buttons
  document.querySelectorAll('.piece-btn').forEach(b => {
    b.addEventListener('click', () => setPieceKind(b.dataset.kind));
  });

  advancedToggle.addEventListener('change', () => {
    advanced = advancedToggle.checked;
    document.querySelectorAll('.btn-tool[data-advanced="1"]').forEach(b => {
      b.style.display = advanced ? '' : 'none';
    });
    if (!advanced && tool === 'wall') setTool('piece');
  });

  splitInput.addEventListener('change', () => { map.split = splitInput.value; draw(); });
  nameInput.addEventListener('change', () => { map.name = nameInput.value; });
  sizeInput.addEventListener('change', () => { setBoardFromSize(sizeInput.value); draw(); });
  snapInput.addEventListener('change', () => { updateHelp(); draw(); });

  // Init
  setBoardFromSize(sizeInput.value);
  setPieceKind('A1');
  setTool('piece');
  applyMapToInputs();
  refreshSummary();
  refreshLoadList();
  draw();

  window.addEventListener('resize', draw);
})();
