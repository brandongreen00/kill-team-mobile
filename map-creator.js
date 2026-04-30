(() => {
  const KT = window.KT;
  const canvas = document.getElementById('creator');
  const ctx = canvas.getContext('2d');
  const help = document.getElementById('creator-help');

  const nameInput = document.getElementById('map-name');
  const splitInput = document.getElementById('map-split');
  const sizeInput = document.getElementById('map-size');
  const snapInput = document.getElementById('snap');
  const terrainTools = document.getElementById('terrain-tools');
  const objectiveTools = document.getElementById('objective-tools');
  const terrainTypeInput = document.getElementById('terrain-type');
  const terrainLabelInput = document.getElementById('terrain-label');
  const objOwnerInput = document.getElementById('obj-owner');
  const layerSummary = document.getElementById('layer-summary');
  const loadSelect = document.getElementById('load-map');

  let board = { width: 28, height: 24, gridSize: 4 };
  let map = blankMap();
  let tool = 'select';
  let pending = null; // first wall click
  let hoverPt = null;

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
      custom: true,
    };
  }

  function setBoardFromSize(value) {
    if (value === '22x30') board = { width: 22, height: 30, gridSize: 4 };
    else board = { width: 28, height: 24, gridSize: 4 };
  }

  // --- Coordinate transforms --------------------------------------------

  function pxPerInch() {
    return canvas.width / board.width / devicePixelRatio;
  }

  function eventToBoard(evt) {
    const rect = canvas.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * board.width;
    const y = ((evt.clientY - rect.top) / rect.height) * board.height;
    return { x, y };
  }

  function snap(v) {
    const s = parseFloat(snapInput.value);
    return Math.round(v / s) * s;
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

    // grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
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

    // sub-grid (1")
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

    // walls
    for (const w of map.walls) {
      ctx.strokeStyle = '#0a0706';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(w.x1 * sx, w.y1 * sy);
      ctx.lineTo(w.x2 * sx, w.y2 * sy);
      ctx.stroke();
    }

    // pending wall preview
    if (pending && hoverPt) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(201,167,77,0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pending.x * sx, pending.y * sy);
      ctx.lineTo(hoverPt.x * sx, hoverPt.y * sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // terrain
    for (const t of map.terrain) drawTerrain(t, sx, sy);

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

    // hover crosshair
    if (hoverPt) {
      const hx = hoverPt.x * sx, hy = hoverPt.y * sy;
      ctx.strokeStyle = 'rgba(201,167,77,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx - 8, hy); ctx.lineTo(hx + 8, hy);
      ctx.moveTo(hx, hy - 8); ctx.lineTo(hx, hy + 8);
      ctx.stroke();
    }
  }

  function drawTerrain(t, sx, sy) {
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
    }
  }

  // --- Tool handlers ----------------------------------------------------

  function setTool(t) {
    tool = t;
    pending = null;
    document.querySelectorAll('.btn-tool').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === t);
    });
    terrainTools.style.display = (t === 'terrain') ? '' : 'none';
    objectiveTools.style.display = (t === 'objective') ? '' : 'none';
    updateHelp();
  }

  function updateHelp() {
    const tips = {
      select: 'Select tool — click to inspect. (No-op)',
      wall: 'Wall tool — click two points to place a wall segment. Snaps to ' + snapInput.value + '".',
      terrain: 'Terrain tool — click to place a ' + terrainTypeInput.value + '.',
      objective: 'Objective tool — click to place an objective marker.',
      erase: 'Erase tool — click on a wall, terrain piece or objective to remove it.',
    };
    help.textContent = tips[tool] || '';
  }

  function nearestErase(p) {
    // Walls (within 0.6")
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

  canvas.addEventListener('mousemove', (evt) => {
    const p = eventToBoard(evt);
    hoverPt = { x: snap(p.x), y: snap(p.y) };
    draw();
  });

  canvas.addEventListener('mouseleave', () => { hoverPt = null; draw(); });

  canvas.addEventListener('click', (evt) => {
    const p = eventToBoard(evt);
    const sp = { x: snap(p.x), y: snap(p.y) };
    if (tool === 'wall') {
      if (!pending) {
        pending = sp;
      } else {
        if (sp.x !== pending.x || sp.y !== pending.y) {
          map.walls.push({ x1: pending.x, y1: pending.y, x2: sp.x, y2: sp.y });
        }
        pending = null;
      }
    } else if (tool === 'terrain') {
      const t = { type: terrainTypeInput.value, x: sp.x, y: sp.y, label: terrainLabelInput.value };
      if (t.type === 'octagon') t.r = 2;
      else if (t.type === 'circle') t.r = 1.5;
      else if (t.type === 'square') t.size = 2;
      else if (t.type === 'barricade') { t.w = 2; t.h = 1; }
      map.terrain.push(t);
    } else if (tool === 'objective') {
      map.objectives.push({ x: sp.x, y: sp.y, owner: objOwnerInput.value });
    } else if (tool === 'erase') {
      const hit = nearestErase(p);
      if (hit) {
        if (hit.kind === 'wall') map.walls.splice(hit.index, 1);
        else if (hit.kind === 'terrain') map.terrain.splice(hit.index, 1);
        else if (hit.kind === 'objective') map.objectives.splice(hit.index, 1);
      }
    }
    refreshSummary();
    draw();
  });

  // --- Sidebar / persistence -------------------------------------------

  function refreshSummary() {
    layerSummary.innerHTML = '';
    function row(label, n) {
      const p = document.createElement('p');
      p.className = 'entry';
      p.textContent = `${label}: ${n}`;
      layerSummary.appendChild(p);
    }
    row('Walls', map.walls.length);
    row('Terrain', map.terrain.length);
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

  loadSelect.addEventListener('change', () => {
    const id = loadSelect.value;
    if (!id) {
      map = blankMap();
    } else {
      const found = KT.getMap(id);
      if (found) {
        map = JSON.parse(JSON.stringify(found));
        if (!map.id.startsWith('custom-')) {
          // forking a built-in map: change id so save creates a new entry
          map.id = 'custom-' + Date.now().toString(36);
          map.name = (map.name || 'Map') + ' (copy)';
          map.custom = true;
        }
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
    alert('Saved "' + map.name + '"');
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

  // Tool buttons
  document.querySelectorAll('.btn-tool').forEach(b => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  splitInput.addEventListener('change', () => { map.split = splitInput.value; draw(); });
  nameInput.addEventListener('change', () => { map.name = nameInput.value; });
  sizeInput.addEventListener('change', () => { setBoardFromSize(sizeInput.value); draw(); });
  snapInput.addEventListener('change', updateHelp);
  terrainTypeInput.addEventListener('change', updateHelp);

  // Init
  setBoardFromSize(sizeInput.value);
  setTool('wall');
  applyMapToInputs();
  refreshSummary();
  refreshLoadList();
  draw();

  window.addEventListener('resize', draw);
})();
