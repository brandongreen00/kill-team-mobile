(() => {
  const GRID = 12;
  const MAX_AP = 2;
  const MOVE_RANGE = 4;
  const SHOOT_RANGE = 7;
  const BASE_HIT = 0.65;
  const COVER_PENALTY = 0.20;

  const MAPS = {
    'gallowdark':  { name: 'Gallowdark Hulk',     eyebrow: 'Derelict Hulk',     cover: 0.18, theme: 'iron'  },
    'ash-wastes':  { name: 'Ash Wastes',          eyebrow: 'Open Dunes',        cover: 0.08, theme: 'ochre' },
    'manufactorum':{ name: 'Manufactorum Ruins',  eyebrow: 'Promethium Works',  cover: 0.14, theme: 'rust'  },
    'hive-vault':  { name: 'Hive Sub-Vault',      eyebrow: 'Subterranean',      cover: 0.20, theme: 'gloom' },
  };

  const TEAM_A = {
    id: 'A',
    name: 'Imperium',
    color: '#c9a74d',
    accent: '#fff8e0',
    units: [
      { name: 'Sergeant',  hp: 10, dmg: 4 },
      { name: 'Gunner',    hp: 8,  dmg: 5 },
      { name: 'Trooper',   hp: 8,  dmg: 3 },
    ]
  };
  const TEAM_B = {
    id: 'B',
    name: 'Chaos',
    color: '#b8203a',
    accent: '#ffd9d9',
    units: [
      { name: 'Champion',  hp: 10, dmg: 4 },
      { name: 'Heretic',   hp: 8,  dmg: 5 },
      { name: 'Cultist',   hp: 8,  dmg: 3 },
    ]
  };

  const mapId = sessionStorage.getItem('kt.mapId') || 'manufactorum';
  const mapDef = MAPS[mapId] || MAPS['manufactorum'];

  document.getElementById('map-eyebrow').textContent = mapDef.eyebrow;
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

  function pseudoRand(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
  }

  function buildTerrain() {
    const cover = [];
    for (let y = 0; y < GRID; y++) {
      const row = [];
      for (let x = 0; x < GRID; x++) {
        const inDeployA = y < 2;
        const inDeployB = y >= GRID - 2;
        const isCover = !inDeployA && !inDeployB && pseudoRand(`${mapId}|${x}|${y}`) < mapDef.cover;
        row.push(isCover ? 1 : 0);
      }
      cover.push(row);
    }
    return cover;
  }

  function buildUnits() {
    const xs = [2, 5, 9];
    const a = TEAM_A.units.map((u, i) => ({
      ...u, team: 'A', x: xs[i], y: 0, ap: MAX_AP, maxHp: u.hp, alive: true
    }));
    const b = TEAM_B.units.map((u, i) => ({
      ...u, team: 'B', x: xs[i], y: GRID - 1, ap: MAX_AP, maxHp: u.hp, alive: true
    }));
    return [...a, ...b];
  }

  const state = {
    turn: 1,
    activeTeam: 'A',
    cover: buildTerrain(),
    units: buildUnits(),
    selectedId: null,
    moveTargets: [],
    shootTargets: [],
    over: false,
  };

  function unitAt(x, y) {
    return state.units.find(u => u.alive && u.x === x && u.y === y) || null;
  }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < GRID && y < GRID;
  }

  function bfsReachable(unit) {
    const dist = Array.from({ length: GRID }, () => Array(GRID).fill(-1));
    dist[unit.y][unit.x] = 0;
    const q = [[unit.x, unit.y]];
    while (q.length) {
      const [cx, cy] = q.shift();
      if (dist[cy][cx] >= MOVE_RANGE) continue;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!inBounds(nx, ny)) continue;
        if (dist[ny][nx] !== -1) continue;
        if (state.cover[ny][nx] === 1) continue;
        const occupant = unitAt(nx, ny);
        if (occupant) continue;
        dist[ny][nx] = dist[cy][cx] + 1;
        q.push([nx, ny]);
      }
    }
    const cells = [];
    for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
      if (dist[y][x] > 0) cells.push({ x, y });
    }
    return cells;
  }

  function losBlockedAndCover(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0, cy = y0;
    let coverCount = 0;
    while (true) {
      if (!(cx === x0 && cy === y0) && !(cx === x1 && cy === y1)) {
        if (state.cover[cy][cx] === 1) coverCount++;
      }
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
    }
    return { blocked: coverCount >= 2, cover: coverCount };
  }

  function shootTargetsFor(unit) {
    const out = [];
    for (const u of state.units) {
      if (!u.alive || u.team === unit.team) continue;
      const dx = u.x - unit.x, dy = u.y - unit.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (dist > SHOOT_RANGE) continue;
      const los = losBlockedAndCover(unit.x, unit.y, u.x, u.y);
      if (los.blocked) continue;
      out.push({ x: u.x, y: u.y, id: u, cover: los.cover });
    }
    return out;
  }

  function selected() {
    return state.units.find(u => u === state.selectedId);
  }

  function recomputeOptions() {
    const u = selected();
    state.moveTargets = (u && u.alive && u.ap > 0) ? bfsReachable(u) : [];
    state.shootTargets = (u && u.alive && u.ap > 0) ? shootTargetsFor(u) : [];
  }

  function log(msg, cls) {
    const p = document.createElement('p');
    p.className = 'entry' + (cls ? ' ' + cls : '');
    p.textContent = msg;
    logEl.appendChild(p);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function teamOf(id) { return id === 'A' ? TEAM_A : TEAM_B; }

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
        </div>
      `;
      if (u.alive && u.team === state.activeTeam) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => {
          state.selectedId = u;
          recomputeOptions();
          render();
        });
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

  function drawBoard() {
    const cs = canvas.clientWidth;
    if (canvas.width !== cs * devicePixelRatio) {
      canvas.width = cs * devicePixelRatio;
      canvas.height = cs * devicePixelRatio;
    }
    const cell = canvas.width / GRID;

    ctx.fillStyle = '#0f0b09';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, canvas.height);
      ctx.moveTo(0, i * cell); ctx.lineTo(canvas.width, i * cell);
      ctx.stroke();
    }

    for (let y = 0; y < GRID; y++) {
      if (y < 2) {
        ctx.fillStyle = 'rgba(201,167,77,0.04)';
        ctx.fillRect(0, y * cell, canvas.width, cell);
      } else if (y >= GRID - 2) {
        ctx.fillStyle = 'rgba(184,32,58,0.05)';
        ctx.fillRect(0, y * cell, canvas.width, cell);
      }
    }

    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (state.cover[y][x] === 1) {
          ctx.fillStyle = '#3a302a';
          ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
          ctx.strokeStyle = '#000';
          ctx.strokeRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
        }
      }
    }

    for (const t of state.moveTargets) {
      ctx.fillStyle = 'rgba(201,167,77,0.18)';
      ctx.fillRect(t.x * cell, t.y * cell, cell, cell);
      ctx.strokeStyle = 'rgba(201,167,77,0.6)';
      ctx.strokeRect(t.x * cell + 0.5, t.y * cell + 0.5, cell - 1, cell - 1);
    }
    for (const t of state.shootTargets) {
      ctx.fillStyle = 'rgba(184,32,58,0.25)';
      ctx.fillRect(t.x * cell, t.y * cell, cell, cell);
      ctx.strokeStyle = '#b8203a';
      ctx.strokeRect(t.x * cell + 0.5, t.y * cell + 0.5, cell - 1, cell - 1);
    }

    for (const u of state.units) {
      if (!u.alive) continue;
      const team = teamOf(u.team);
      const cx = u.x * cell + cell / 2;
      const cy = u.y * cell + cell / 2;
      const r = cell * 0.32;

      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(cx + 1, cy + 2, r, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = team.color;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = team.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (u === state.selectedId) {
        ctx.strokeStyle = '#fff8e0';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.stroke();
      }

      const hpPct = u.hp / u.maxHp;
      const barW = cell * 0.7;
      const bx = cx - barW / 2, by = cy + r + 4;
      ctx.fillStyle = '#000';
      ctx.fillRect(bx - 1, by - 1, barW + 2, 5);
      ctx.fillStyle = '#3a302a';
      ctx.fillRect(bx, by, barW, 3);
      ctx.fillStyle = hpPct > 0.5 ? '#c9a74d' : (hpPct > 0.25 ? '#e68a6a' : '#b8203a');
      ctx.fillRect(bx, by, barW * hpPct, 3);
    }
  }

  function render() {
    drawBoard();
    renderSidebar();
    renderHud();
  }

  function getCell(evt) {
    const rect = canvas.getBoundingClientRect();
    const px = (evt.clientX - rect.left) / rect.width;
    const py = (evt.clientY - rect.top) / rect.height;
    return { x: Math.floor(px * GRID), y: Math.floor(py * GRID) };
  }

  canvas.addEventListener('click', (evt) => {
    if (state.over) return;
    const { x, y } = getCell(evt);
    if (!inBounds(x, y)) return;

    const clicked = unitAt(x, y);
    const u = selected();

    if (clicked && clicked.team === state.activeTeam) {
      state.selectedId = clicked;
      recomputeOptions();
      render();
      return;
    }

    if (!u || u.team !== state.activeTeam || !u.alive || u.ap <= 0) return;

    if (clicked && clicked.team !== state.activeTeam) {
      const target = state.shootTargets.find(t => t.x === x && t.y === y);
      if (target) {
        resolveShoot(u, clicked, target.cover);
        u.ap -= 1;
        recomputeOptions();
        afterAction();
        render();
      }
      return;
    }

    const moveTarget = state.moveTargets.find(t => t.x === x && t.y === y);
    if (moveTarget) {
      u.x = x; u.y = y;
      u.ap -= 1;
      log(`${teamOf(u.team).name} ${u.name} repositions.`);
      recomputeOptions();
      afterAction();
      render();
    }
  });

  function resolveShoot(attacker, defender, coverCount) {
    const hitChance = Math.max(0.1, BASE_HIT - COVER_PENALTY * coverCount);
    const roll = Math.random();
    const hit = roll < hitChance;
    if (!hit) {
      log(`${teamOf(attacker.team).name} ${attacker.name} fires at ${defender.name} — miss.`);
      return;
    }
    const dmg = attacker.dmg + (Math.random() < 0.2 ? 1 : 0);
    defender.hp -= dmg;
    if (defender.hp <= 0) {
      defender.hp = 0;
      defender.alive = false;
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
      recomputeOptions();
    }
  }

  function endTurn() {
    if (state.over) return;
    state.activeTeam = state.activeTeam === 'A' ? 'B' : 'A';
    if (state.activeTeam === 'A') state.turn += 1;
    state.units.forEach(u => { if (u.alive) u.ap = MAX_AP; });
    const next = state.units.find(u => u.alive && u.team === state.activeTeam);
    state.selectedId = next || null;
    recomputeOptions();
    log(`— ${teamOf(state.activeTeam).name} activation begins —`, 'turn');

    if (state.activeTeam === 'B') {
      setTimeout(runAITurn, 350);
    }
    render();
  }

  endTurnBtn.addEventListener('click', endTurn);

  function runAITurn() {
    if (state.over) return;
    if (state.activeTeam !== 'B') return;

    const aiUnits = state.units.filter(u => u.alive && u.team === 'B');
    let actedThisPass = true;

    function step() {
      if (state.over || state.activeTeam !== 'B') return;
      let didSomething = false;
      for (const u of aiUnits) {
        if (!u.alive || u.ap <= 0) continue;
        state.selectedId = u;
        recomputeOptions();

        const targets = shootTargetsFor(u);
        if (targets.length) {
          targets.sort((a, b) => a.id.hp - b.id.hp);
          const t = targets[0];
          resolveShoot(u, t.id, t.cover);
          u.ap -= 1;
          didSomething = true;
          afterAction();
          render();
          if (state.over) return;
          break;
        }

        const enemies = state.units.filter(o => o.alive && o.team === 'A');
        if (enemies.length === 0) break;
        const reach = bfsReachable(u);
        if (reach.length === 0) continue;
        let best = reach[0], bestD = Infinity;
        for (const c of reach) {
          let d = Infinity;
          for (const e of enemies) {
            const dd = Math.abs(c.x - e.x) + Math.abs(c.y - e.y);
            if (dd < d) d = dd;
          }
          if (d < bestD) { bestD = d; best = c; }
        }
        u.x = best.x; u.y = best.y;
        u.ap -= 1;
        log(`${teamOf(u.team).name} ${u.name} advances.`);
        didSomething = true;
        afterAction();
        render();
        break;
      }

      if (didSomething) {
        const stillActing = aiUnits.some(u => u.alive && u.ap > 0);
        if (stillActing) {
          setTimeout(step, 320);
          return;
        }
      }
      setTimeout(endTurn, 400);
    }

    step();
  }

  log(`— Engagement begins on ${mapDef.name} —`, 'turn');
  log(`Imperium activation begins.`, 'turn');
  state.selectedId = state.units.find(u => u.team === 'A' && u.alive);
  recomputeOptions();
  render();

  window.addEventListener('resize', render);
})();
