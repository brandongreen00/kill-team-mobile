(() => {
  const KT = window.KT;
  const BOARD = KT.TOMB_BOARD;

  // Inch-based mechanics
  const MAX_AP = 2;
  const MOVE_INCHES = 6;
  const SHOOT_RANGE_INCHES = 14;
  const UNIT_RADIUS = 0.6;
  const COVER_RADIUS = 1.2;
  const BASE_HIT = 0.65;
  const COVER_PENALTY = 0.20;

  const TEAM_A = {
    id: 'A', name: 'Imperium', color: '#c9a74d', accent: '#fff8e0',
    units: [
      { name: 'Sergeant', hp: 10, dmg: 4 },
      { name: 'Gunner',   hp: 8,  dmg: 5 },
      { name: 'Trooper',  hp: 8,  dmg: 3 },
    ],
  };
  const TEAM_B = {
    id: 'B', name: 'Chaos', color: '#b8203a', accent: '#ffd9d9',
    units: [
      { name: 'Champion', hp: 10, dmg: 4 },
      { name: 'Heretic',  hp: 8,  dmg: 5 },
      { name: 'Cultist',  hp: 8,  dmg: 3 },
    ],
  };

  const mapId = sessionStorage.getItem('kt.mapId') || 'tomb-1';
  const mapDef = KT.getMap(mapId) || KT.TOMB_MAPS['tomb-1'];

  document.getElementById('map-eyebrow').textContent = mapDef.eyebrow || 'Tomb World';
  document.getElementById('map-title').textContent = mapDef.name;

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const logEl = document.getElementById('log');
  const turnChip = document.getElementById('turn-chip');
  const apChip = document.getElementById('ap-chip');
  const turnBanner = document.getElementById('turn-banner');
  const endTurnBtn = document.getElementById('end-turn-btn');
  const teamAEl = document.getElementById('team-a');
  const teamBEl = document.getElementById('team-b');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayText = document.getElementById('overlay-text');

  // --- Unit deployment (gridless) --------------------------------------

  function deployUnits() {
    const aZone = KT.deployZone(mapDef, 'A');
    const bZone = KT.deployZone(mapDef, 'B');
    function spread(zone, count) {
      const out = [];
      const horizontal = zone.w >= zone.h;
      for (let i = 0; i < count; i++) {
        const t = (i + 1) / (count + 1);
        if (horizontal) {
          out.push({ x: zone.x + zone.w * t, y: zone.y + zone.h * 0.5 });
        } else {
          out.push({ x: zone.x + zone.w * 0.5, y: zone.y + zone.h * t });
        }
      }
      return out;
    }
    const aPos = spread(aZone, TEAM_A.units.length);
    const bPos = spread(bZone, TEAM_B.units.length);
    const a = TEAM_A.units.map((u, i) => ({
      ...u, team: 'A', x: aPos[i].x, y: aPos[i].y,
      ap: MAX_AP, maxHp: u.hp, alive: true,
    }));
    const b = TEAM_B.units.map((u, i) => ({
      ...u, team: 'B', x: bPos[i].x, y: bPos[i].y,
      ap: MAX_AP, maxHp: u.hp, alive: true,
    }));
    return [...a, ...b];
  }

  const state = {
    turn: 1,
    activeTeam: 'A',
    units: deployUnits(),
    selectedId: null,
    hoverPt: null,
    over: false,
  };

  function teamOf(id) { return id === 'A' ? TEAM_A : TEAM_B; }
  function selected() { return state.units.find(u => u === state.selectedId); }

  function unitAtPoint(x, y) {
    return state.units.find(u => u.alive && Math.hypot(u.x - x, u.y - y) <= UNIT_RADIUS + 0.4);
  }

  function unitOccupiesCircle(x, y, r, ignore) {
    return state.units.find(u => u.alive && u !== ignore &&
      Math.hypot(u.x - x, u.y - y) < r + UNIT_RADIUS);
  }

  // --- Movement & LOS ---------------------------------------------------

  function moveCost(u, x, y) { return Math.hypot(x - u.x, y - u.y); }

  function canMoveTo(u, x, y) {
    if (x < UNIT_RADIUS || y < UNIT_RADIUS) return false;
    if (x > BOARD.width - UNIT_RADIUS || y > BOARD.height - UNIT_RADIUS) return false;
    if (moveCost(u, x, y) > MOVE_INCHES) return false;
    if (KT.geom.losBlocked(mapDef, u.x, u.y, x, y)) return false;
    if (unitOccupiesCircle(x, y, UNIT_RADIUS, u)) return false;
    return true;
  }

  function shotCoverPenalty(x1, y1, x2, y2) {
    let penalties = 0;
    for (const t of mapDef.terrain || []) {
      const tx = t.x, ty = t.y;
      let r = COVER_RADIUS;
      if (t.type === 'octagon') r = (t.r || 2);
      else if (t.type === 'circle') r = (t.r || 1.5);
      else if (t.type === 'square') r = (t.size || 2) * 0.5;
      else if (t.type === 'barricade') {
        const d = KT.geom.pointSegDist(tx, ty, x1, y1, x2, y2);
        if (d < 0.6) penalties++;
        continue;
      }
      const d = KT.geom.pointSegDist(tx, ty, x1, y1, x2, y2);
      if (d < r) penalties++;
    }
    return penalties;
  }

  function shootTargetsFor(u) {
    const out = [];
    for (const o of state.units) {
      if (!o.alive || o.team === u.team) continue;
      const dist = Math.hypot(o.x - u.x, o.y - u.y);
      if (dist > SHOOT_RANGE_INCHES) continue;
      if (KT.geom.losBlocked(mapDef, u.x, u.y, o.x, o.y)) continue;
      out.push({ target: o, cover: shotCoverPenalty(u.x, u.y, o.x, o.y) });
    }
    return out;
  }

  // --- Logging & sidebar ------------------------------------------------

  function log(msg, cls) {
    const p = document.createElement('p');
    p.className = 'entry' + (cls ? ' ' + cls : '');
    p.textContent = msg;
    logEl.appendChild(p);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderSidebar() {
    function rowFor(u) {
      const team = teamOf(u.team);
      const div = document.createElement('div');
      div.className = 'unit-row' + (u === state.selectedId ? ' selected' : '') + (u.alive ? '' : ' dead');
      div.innerHTML = `
        <div class="swatch" style="background:${team.color};"></div>
        <div class="meta">
          <div class="name">${u.name}</div>
          <div class="stats">HP ${u.alive ? u.hp : 0}/${u.maxHp} &middot; AP ${u.alive ? u.ap : 0}/${MAX_AP} &middot; DMG ${u.dmg}</div>
        </div>`;
      if (u.alive && u.team === state.activeTeam) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => { state.selectedId = u; render(); });
      }
      return div;
    }
    teamAEl.innerHTML = '';
    teamBEl.innerHTML = '';
    state.units.filter(u => u.team === 'A').forEach(u => teamAEl.appendChild(rowFor(u)));
    state.units.filter(u => u.team === 'B').forEach(u => teamBEl.appendChild(rowFor(u)));
  }

  function renderHud() {
    turnChip.textContent = `Turn ${state.turn}`;
    const u = selected();
    apChip.textContent = u ? `AP ${u.ap}/${MAX_AP}` : 'AP —';
    turnBanner.textContent = `${teamOf(state.activeTeam).name} Activation`;
    turnBanner.style.color = teamOf(state.activeTeam).color;
  }

  // --- Rendering --------------------------------------------------------

  function fitCanvas() {
    const w = canvas.clientWidth;
    const aspect = BOARD.width / BOARD.height;
    canvas.style.height = (w / aspect) + 'px';
    if (canvas.width !== w * devicePixelRatio) {
      canvas.width = w * devicePixelRatio;
      canvas.height = (w / aspect) * devicePixelRatio;
    }
  }

  function scale() { return canvas.width / BOARD.width; }

  function drawBoard() {
    fitCanvas();
    const W = canvas.width, H = canvas.height;
    const s = W / BOARD.width;

    ctx.fillStyle = '#0f0b09';
    ctx.fillRect(0, 0, W, H);

    // deployment fills
    const aZone = KT.deployZone(mapDef, 'A');
    const bZone = KT.deployZone(mapDef, 'B');
    ctx.fillStyle = 'rgba(233, 176, 122, 0.20)';
    ctx.fillRect(aZone.x * s, aZone.y * s, aZone.w * s, aZone.h * s);
    ctx.fillStyle = 'rgba(157, 160, 168, 0.18)';
    ctx.fillRect(bZone.x * s, bZone.y * s, bZone.w * s, bZone.h * s);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= BOARD.width; x += BOARD.gridSize) {
      ctx.beginPath(); ctx.moveTo(x * s, 0); ctx.lineTo(x * s, H); ctx.stroke();
    }
    for (let y = 0; y <= BOARD.height; y += BOARD.gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y * s); ctx.lineTo(W, y * s); ctx.stroke();
    }

    // dashed deployment divider
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (mapDef.split === 'vertical') {
      ctx.moveTo((BOARD.width / 2) * s, 0);
      ctx.lineTo((BOARD.width / 2) * s, H);
    } else {
      ctx.moveTo(0, (BOARD.height / 2) * s);
      ctx.lineTo(W, (BOARD.height / 2) * s);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // walls
    ctx.strokeStyle = '#0a0706';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const w of mapDef.walls || []) {
      ctx.beginPath();
      ctx.moveTo(w.x1 * s, w.y1 * s);
      ctx.lineTo(w.x2 * s, w.y2 * s);
      ctx.stroke();
    }

    // perimeter
    ctx.strokeRect(2, 2, W - 4, H - 4);

    // terrain
    for (const t of mapDef.terrain || []) drawTerrain(t, s);

    // objectives
    for (const o of mapDef.objectives || []) {
      const fill = o.owner === 'A' ? '#b8203a' : (o.owner === 'B' ? '#fff' : '#0a0706');
      const ring = o.owner === 'A' ? '#fff' : (o.owner === 'B' ? '#0a0706' : '#fff');
      ctx.fillStyle = fill;
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(o.x * s, o.y * s, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // movement preview
    const u = selected();
    if (u && u.alive && u.ap > 0 && u.team === state.activeTeam) {
      ctx.strokeStyle = 'rgba(201,167,77,0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(u.x * s, u.y * s, MOVE_INCHES * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      if (state.hoverPt) {
        const ok = canMoveTo(u, state.hoverPt.x, state.hoverPt.y);
        ctx.strokeStyle = ok ? 'rgba(201,167,77,0.95)' : 'rgba(184,32,58,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(u.x * s, u.y * s);
        ctx.lineTo(state.hoverPt.x * s, state.hoverPt.y * s);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(state.hoverPt.x * s, state.hoverPt.y * s, UNIT_RADIUS * s, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // units
    for (const u of state.units) {
      if (!u.alive) continue;
      const team = teamOf(u.team);
      const cx = u.x * s, cy = u.y * s;
      const r = UNIT_RADIUS * s;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(cx + 1, cy + 2, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = team.color;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = team.accent;
      ctx.lineWidth = 1.5; ctx.stroke();
      if (u === state.selectedId) {
        ctx.strokeStyle = '#fff8e0';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.stroke();
      }
      const hpPct = u.hp / u.maxHp;
      const barW = r * 2.4, bx = cx - barW / 2, by = cy + r + 4;
      ctx.fillStyle = '#000'; ctx.fillRect(bx - 1, by - 1, barW + 2, 5);
      ctx.fillStyle = '#3a302a'; ctx.fillRect(bx, by, barW, 3);
      ctx.fillStyle = hpPct > 0.5 ? '#c9a74d' : (hpPct > 0.25 ? '#e68a6a' : '#b8203a');
      ctx.fillRect(bx, by, barW * hpPct, 3);
    }
  }

  function drawTerrain(t, s) {
    ctx.fillStyle = '#0a0706';
    if (t.type === 'octagon') {
      const cx = t.x * s, cy = t.y * s, r = (t.r || 2) * s;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + i * Math.PI / 4;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
    } else if (t.type === 'circle') {
      ctx.beginPath();
      ctx.arc(t.x * s, t.y * s, (t.r || 1.5) * s, 0, Math.PI * 2);
      ctx.fill();
      if (t.label) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(0.7 * s)}px monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.label, t.x * s, t.y * s);
      }
    } else if (t.type === 'square') {
      const sz = (t.size || 2) * s;
      ctx.fillRect(t.x * s - sz / 2, t.y * s - sz / 2, sz, sz);
      if (t.label) {
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.round(0.6 * s)}px monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t.label, t.x * s, t.y * s);
      }
    } else if (t.type === 'barricade') {
      ctx.strokeStyle = '#3a302a';
      ctx.lineWidth = 2;
      ctx.strokeRect(t.x * s, t.y * s, t.w * s, t.h * s);
    }
  }

  function render() { drawBoard(); renderSidebar(); renderHud(); }

  // --- Input ------------------------------------------------------------

  function eventToBoard(evt) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((evt.clientX - rect.left) / rect.width) * BOARD.width,
      y: ((evt.clientY - rect.top) / rect.height) * BOARD.height,
    };
  }

  canvas.addEventListener('mousemove', (evt) => {
    state.hoverPt = eventToBoard(evt);
    if (selected()) drawBoard();
  });
  canvas.addEventListener('mouseleave', () => { state.hoverPt = null; drawBoard(); });

  canvas.addEventListener('click', (evt) => {
    if (state.over) return;
    const p = eventToBoard(evt);
    const clicked = unitAtPoint(p.x, p.y);
    const u = selected();

    if (clicked && clicked.team === state.activeTeam && clicked.alive) {
      state.selectedId = clicked;
      render();
      return;
    }

    if (!u || u.team !== state.activeTeam || !u.alive || u.ap <= 0) return;

    if (clicked && clicked.team !== state.activeTeam) {
      const list = shootTargetsFor(u);
      const t = list.find(t => t.target === clicked);
      if (t) {
        resolveShoot(u, clicked, t.cover);
        u.ap -= 1;
        afterAction();
        render();
      }
      return;
    }

    if (canMoveTo(u, p.x, p.y)) {
      const d = moveCost(u, p.x, p.y);
      u.x = p.x; u.y = p.y;
      u.ap -= 1;
      log(`${teamOf(u.team).name} ${u.name} repositions ${d.toFixed(1)}".`);
      afterAction();
      render();
    }
  });

  function resolveShoot(attacker, defender, coverCount) {
    const hitChance = Math.max(0.1, BASE_HIT - COVER_PENALTY * coverCount);
    const hit = Math.random() < hitChance;
    if (!hit) {
      log(`${teamOf(attacker.team).name} ${attacker.name} fires at ${defender.name} — miss.`);
      return;
    }
    const dmg = attacker.dmg + (Math.random() < 0.2 ? 1 : 0);
    defender.hp -= dmg;
    if (defender.hp <= 0) {
      defender.hp = 0; defender.alive = false;
      log(`${defender.name} is slain by ${attacker.name}.`, 'kill');
    } else {
      log(`${attacker.name} hits ${defender.name} for ${dmg}.`, 'hit');
    }
  }

  function afterAction() {
    const aAlive = state.units.some(u => u.team === 'A' && u.alive);
    const bAlive = state.units.some(u => u.team === 'B' && u.alive);
    if (!aAlive || !bAlive) {
      state.over = true;
      const winner = aAlive ? TEAM_A : TEAM_B;
      overlayTitle.textContent = `${winner.name} Victorious`;
      overlayText.textContent = aAlive
        ? 'The Emperor protects. The heretics lie broken.'
        : 'The Imperium falters. Chaos reigns this day.';
      overlay.style.display = 'flex';
      return;
    }
    const u = selected();
    if (u && u.ap <= 0) {
      const next = state.units.find(o => o.alive && o.team === state.activeTeam && o.ap > 0);
      state.selectedId = next || null;
    }
  }

  function endTurn() {
    if (state.over) return;
    state.activeTeam = state.activeTeam === 'A' ? 'B' : 'A';
    if (state.activeTeam === 'A') state.turn += 1;
    state.units.forEach(u => { if (u.alive) u.ap = MAX_AP; });
    state.selectedId = state.units.find(u => u.alive && u.team === state.activeTeam) || null;
    log(`— ${teamOf(state.activeTeam).name} activation begins —`, 'turn');
    if (state.activeTeam === 'B') setTimeout(runAITurn, 350);
    render();
  }

  endTurnBtn.addEventListener('click', endTurn);

  function runAITurn() {
    if (state.over || state.activeTeam !== 'B') return;
    const aiUnits = state.units.filter(u => u.alive && u.team === 'B');
    function step() {
      if (state.over || state.activeTeam !== 'B') return;
      let didSomething = false;
      for (const u of aiUnits) {
        if (!u.alive || u.ap <= 0) continue;
        state.selectedId = u;
        const targets = shootTargetsFor(u);
        if (targets.length) {
          targets.sort((a, b) => a.target.hp - b.target.hp);
          const t = targets[0];
          resolveShoot(u, t.target, t.cover);
          u.ap -= 1; didSomething = true; afterAction(); render();
          if (state.over) return;
          break;
        }
        const enemies = state.units.filter(o => o.alive && o.team === 'A');
        if (!enemies.length) break;
        // Move toward closest enemy along clear path within MOVE_INCHES.
        let target = enemies[0], best = Infinity;
        for (const e of enemies) {
          const d = Math.hypot(e.x - u.x, e.y - u.y);
          if (d < best) { best = d; target = e; }
        }
        const dx = target.x - u.x, dy = target.y - u.y;
        const dist = Math.hypot(dx, dy) || 1;
        let stepDist = Math.min(MOVE_INCHES, dist - 1.5);
        let nx = u.x + (dx / dist) * stepDist;
        let ny = u.y + (dy / dist) * stepDist;
        // Try to find a clear move; if blocked, jitter angle.
        let tries = 0;
        while ((!canMoveTo(u, nx, ny)) && tries < 8) {
          const ang = Math.atan2(dy, dx) + (tries % 2 ? 1 : -1) * (Math.PI / 8) * Math.ceil(tries / 2);
          stepDist = Math.min(MOVE_INCHES, dist - 1.5);
          nx = u.x + Math.cos(ang) * stepDist;
          ny = u.y + Math.sin(ang) * stepDist;
          tries++;
        }
        if (canMoveTo(u, nx, ny)) {
          u.x = nx; u.y = ny; u.ap -= 1;
          log(`${teamOf(u.team).name} ${u.name} advances.`);
          didSomething = true; afterAction(); render();
        } else {
          u.ap -= 1;
        }
        break;
      }
      if (didSomething && aiUnits.some(u => u.alive && u.ap > 0)) {
        setTimeout(step, 320); return;
      }
      setTimeout(endTurn, 400);
    }
    step();
  }

  log(`— Engagement begins on ${mapDef.name} —`, 'turn');
  log(`Imperium activation begins.`, 'turn');
  state.selectedId = state.units.find(u => u.team === 'A' && u.alive);
  render();

  window.addEventListener('resize', render);
})();
