(() => {
  const KT = window.KT;
  const FACTIONS = window.FACTIONS || [];
  const BOARD = KT.TOMB_BOARD;

  // ── Constants ────────────────────────────────────────────────────────
  const MAX_AP = 2;
  const MOVE_INCHES = 6;
  const SHOOT_RANGE_INCHES = 14;
  const COVER_RADIUS = 1.2;
  const BASE_HIT = 0.65;
  const COVER_PENALTY = 0.20;
  const MM_PER_INCH = 25.4;
  const DEFAULT_BASE_MM = 28;

  // Neutral palette: blue for Player A, red for Player B. The actual faction
  // each player picked is shown in the sidebar / stat block.
  const TEAM_INFO = {
    A: { name: 'Player Blue', short: 'BLUE', color: '#3a6db8', accent: '#dbe8ff', text: '#fff8e0' },
    B: { name: 'Player Red',  short: 'RED',  color: '#b8203a', accent: '#ffd9d9', text: '#fff8e0' },
  };

  const FACTIONS_BY_ID = Object.fromEntries(FACTIONS.map(f => [f.id, f]));
  function operativeOf(factionId, operativeId) {
    const f = FACTIONS_BY_ID[factionId];
    if (!f) return null;
    return f.operatives.find(o => o.id === operativeId) || null;
  }

  // ── Roster storage ───────────────────────────────────────────────────
  const ROSTER_KEY = 'kt.rosters.v1';
  function loadRosters() {
    try {
      const raw = localStorage.getItem(ROSTER_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  // ── Map ──────────────────────────────────────────────────────────────
  const mapId = sessionStorage.getItem('kt.mapId') || 'tomb-1';
  const mapDefRaw = KT.getMap(mapId) || KT.TOMB_MAPS['tomb-1'];
  const mapDef = KT.compileMap(mapDefRaw);

  document.getElementById('map-eyebrow').textContent = mapDefRaw.eyebrow || (mapDefRaw.custom ? 'Custom Map' : 'Tomb World');
  document.getElementById('map-title').textContent = mapDefRaw.name;

  // ── Geometry helpers ────────────────────────────────────────────────
  // Each operative carries `base` (mm). A round base has { d } and renders
  // as a circle; an oval base has { w, h } where w runs along the operative's
  // facing. Until rotation matters mechanically we render ovals long-axis-
  // horizontal regardless of facing.
  function unitRadii(u) {
    const b = u && u.base;
    if (!b) {
      const r = (DEFAULT_BASE_MM / 2) / MM_PER_INCH;
      return { rx: r, ry: r };
    }
    if (b.d != null) {
      const r = (b.d / 2) / MM_PER_INCH;
      return { rx: r, ry: r };
    }
    return { rx: (b.w / 2) / MM_PER_INCH, ry: (b.h / 2) / MM_PER_INCH };
  }
  function unitRadiusMax(u) {
    const { rx, ry } = unitRadii(u);
    return Math.max(rx, ry);
  }

  // ── Letter assignment (distinct codes within a team) ────────────────
  // Group units by display name; each name gets a single unique base letter
  // (preferring its own first character, walking subsequent characters or
  // falling back to A..Z if every initial is taken). When a name appears
  // more than once, render as letter+index (e.g. "T1", "T2") so duplicates
  // are still distinguishable.
  function assignLetters(units) {
    const cleaned = units.map(u =>
      String(u._displayName || u.name || '').replace(/[^A-Za-z]/g, '').toUpperCase());
    const groups = {};
    cleaned.forEach((name, i) => {
      groups[name] = groups[name] || [];
      groups[name].push(i);
    });
    // Process larger groups first so a frequently-fielded operative gets first
    // claim on its initial.
    const orderedNames = Object.keys(groups)
      .sort((a, b) => groups[b].length - groups[a].length || a.localeCompare(b));

    const used = new Set();
    const baseLetter = {};
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const name of orderedNames) {
      let pick = null;
      for (const ch of name) {
        if (!used.has(ch)) { pick = ch; break; }
      }
      if (!pick) {
        for (const ch of ALPHA) {
          if (!used.has(ch)) { pick = ch; break; }
        }
      }
      pick = pick || '?';
      used.add(pick);
      baseLetter[name] = pick;
    }

    const codes = new Array(units.length).fill('?');
    for (const name of orderedNames) {
      const letter = baseLetter[name];
      const idxs = groups[name];
      if (idxs.length === 1) {
        codes[idxs[0]] = letter;
      } else {
        idxs.forEach((unitIdx, n) => { codes[unitIdx] = letter + (n + 1); });
      }
    }
    return codes;
  }

  // ── Build units from roster picks ────────────────────────────────────
  function unitsFromRoster(roster, team) {
    if (!roster) return [];
    const f = FACTIONS_BY_ID[roster.factionId];
    const facName = f ? f.name : '—';
    const built = [];
    roster.picks.forEach(pick => {
      const op = operativeOf(roster.factionId, pick.operativeId);
      if (!op) return;
      // Cosmetic display name dropping the faction prefix (e.g. "KASRKIN ").
      let display = (op.full_name || op.name || '').trim();
      if (display.toUpperCase().startsWith(facName.toUpperCase() + ' ')) {
        display = display.slice(facName.length + 1).trim();
      }
      if (!display) display = op.name;
      // Wounds drives our HP. Use a flat damage approximation from the best
      // ranged weapon (or melee if none) until weapon-specific logic lands.
      const weapons = op.weapons || [];
      const ranged = weapons.find(w => !w.is_melee);
      const melee  = weapons.find(w => w.is_melee);
      const dmgWeapon = ranged || melee || { normal_dmg: 3 };
      built.push({
        team,
        operativeId: op.id,
        factionId: roster.factionId,
        rangedChoice: pick.rangedChoice || null,
        meleeChoice:  pick.meleeChoice  || null,
        name: op.name,
        fullName: op.full_name || op.name,
        _displayName: display,
        save: op.save,
        wounds: op.wounds,
        apl: op.apl,
        move: op.move,
        base: op.base || { d: DEFAULT_BASE_MM },
        weapons,
        // mechanics
        hp: op.wounds,
        maxHp: op.wounds,
        dmg: dmgWeapon.normal_dmg || 3,
        ap: MAX_AP,
        alive: true,
        deployed: false,
        x: null, y: null,
      });
    });
    const codes = assignLetters(built);
    built.forEach((u, i) => { u.letter = codes[i]; });
    return built;
  }

  // ── State machine ────────────────────────────────────────────────────
  const state = {
    phase: 'teams',  // 'teams' | 'initiative' | 'deploy' | 'combat' | 'over'
    rosters: { A: null, B: null },
    units: [],

    initiative: {
      a: null, b: null, winner: null, animating: false,
    },

    deploy: {
      first: null,                   // who deploys first overall
      currentTeam: null,             // whose turn within deployment
      batches: { A: [], B: [] },     // batches[team][round] = number of units
      placedCount: { A: 0, B: 0 },
      round: 0,                      // 0..2
      pendingUnit: null,             // the unit selected to be placed next
    },

    combat: {
      turn: 1,
      activeTeam: 'A',
      selectedId: null,
      hoverPt: null,
      over: false,
    },

    hoverUnit: null,                 // for the stat block popup
    pinnedStatUnit: null,            // tap-pinned (mobile)
  };

  // ── DOM refs ─────────────────────────────────────────────────────────
  const phasePanels = {
    teams: document.getElementById('phase-teams'),
    initiative: document.getElementById('phase-initiative'),
    board: document.getElementById('phase-board'),
  };
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const logEl = document.getElementById('log');
  const turnBanner = document.getElementById('turn-banner');
  const phaseChip = document.getElementById('phase-chip');
  const batchChip = document.getElementById('batch-chip');
  const endTurnBtn = document.getElementById('end-turn-btn');
  const teamAEl = document.getElementById('team-a');
  const teamBEl = document.getElementById('team-b');
  const sidebarALabel = document.getElementById('sidebar-A-label');
  const sidebarBLabel = document.getElementById('sidebar-B-label');
  const deployStatus = document.getElementById('deploy-status');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayText = document.getElementById('overlay-text');
  const statBlockEl = document.getElementById('stat-block');

  function setPhase(name) {
    state.phase = name;
    Object.entries(phasePanels).forEach(([k, el]) => {
      if (k === 'board') {
        el.style.display = (name === 'deploy' || name === 'combat' || name === 'over') ? '' : 'none';
      } else {
        el.style.display = (k === name) ? '' : 'none';
      }
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ── Phase 1: Team selection ──────────────────────────────────────────
  function renderTeamPicker() {
    const rosters = loadRosters();
    ['A', 'B'].forEach(team => {
      const list = document.getElementById('roster-list-' + team);
      list.innerHTML = '';
      if (!rosters.length) {
        const empty = document.createElement('div');
        empty.className = 'roster-empty-state';
        empty.style.padding = '20px 12px';
        empty.textContent = 'No rosters saved. Build one from the Roster screen.';
        list.appendChild(empty);
        return;
      }
      rosters.forEach(r => {
        const f = FACTIONS_BY_ID[r.factionId];
        const card = document.createElement('div');
        card.className = 'roster-pick-card';
        card.dataset.rosterId = r.id;
        card.innerHTML = `
          <div class="roster-pick-name"></div>
          <div class="roster-pick-meta"></div>
        `;
        card.querySelector('.roster-pick-name').textContent = r.name || 'Untitled Kill Team';
        card.querySelector('.roster-pick-meta').textContent =
          (f ? f.name : '—') + ' · ' + r.picks.length + ' operative' + (r.picks.length === 1 ? '' : 's');
        card.addEventListener('click', () => selectRoster(team, r));
        if (state.rosters[team] && state.rosters[team].id === r.id) {
          card.classList.add('selected');
        }
        list.appendChild(card);
      });
    });
    updateTeamPickerUI();
  }

  function selectRoster(team, roster) {
    state.rosters[team] = roster;
    document.querySelectorAll('#roster-list-' + team + ' .roster-pick-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.rosterId === roster.id);
    });
    updateTeamPickerUI();
  }

  function updateTeamPickerUI() {
    ['A', 'B'].forEach(team => {
      const r = state.rosters[team];
      const summary = document.getElementById('roster-summary-' + team);
      if (r) {
        const f = FACTIONS_BY_ID[r.factionId];
        summary.textContent = (r.name || 'Untitled') + ' · ' + (f ? f.name : '—') + ' · ' + r.picks.length + ' operatives';
        summary.classList.add('has-team');
      } else {
        summary.textContent = 'No team chosen.';
        summary.classList.remove('has-team');
      }
    });
    const ok = state.rosters.A && state.rosters.B
      && state.rosters.A.picks.length > 0 && state.rosters.B.picks.length > 0;
    document.getElementById('confirm-teams').disabled = !ok;
  }

  document.getElementById('confirm-teams').addEventListener('click', () => {
    if (!state.rosters.A || !state.rosters.B) return;
    state.units = [
      ...unitsFromRoster(state.rosters.A, 'A'),
      ...unitsFromRoster(state.rosters.B, 'B'),
    ];
    state.initiative = { a: null, b: null, winner: null, animating: false };
    syncDiceLabels();
    resetDiceFaces();
    document.getElementById('roll-btn').textContent = 'Roll Dice';
    setPhase('initiative');
  });

  // ── Phase 2: Initiative roll ─────────────────────────────────────────
  function syncDiceLabels() {
    const labelA = state.rosters.A
      ? (state.rosters.A.name || 'Untitled') + ' (Blue)'
      : 'Player Blue';
    const labelB = state.rosters.B
      ? (state.rosters.B.name || 'Untitled') + ' (Red)'
      : 'Player Red';
    document.getElementById('dice-name-A').textContent = labelA;
    document.getElementById('dice-name-B').textContent = labelB;
    sidebarALabel.textContent = labelA;
    sidebarBLabel.textContent = labelB;
    document.getElementById('team-pick-label-A').textContent = 'Player Blue';
    document.getElementById('team-pick-label-B').textContent = 'Player Red';
  }

  function diceSVG(value, accent) {
    // 100x100 viewBox, 6 face dot-positions; 'accent' tints the rim only.
    const dots = {
      1: [[50, 50]],
      2: [[28, 28], [72, 72]],
      3: [[28, 28], [50, 50], [72, 72]],
      4: [[28, 28], [72, 28], [28, 72], [72, 72]],
      5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
      6: [[28, 28], [72, 28], [28, 50], [72, 50], [28, 72], [72, 72]],
    };
    const pips = (dots[value] || []).map(([x, y]) =>
      `<circle cx="${x}" cy="${y}" r="7" fill="#0a0706"/>`).join('');
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="dice-svg">
      <defs>
        <linearGradient id="dieGrad-${accent.replace('#','')}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fff8e0"/>
          <stop offset="100%" stop-color="#dccfa6"/>
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="88" height="88" rx="14"
            fill="url(#dieGrad-${accent.replace('#','')})"
            stroke="${accent}" stroke-width="3"/>
      <rect x="6" y="6" width="88" height="88" rx="14"
            fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1"/>
      ${pips}
    </svg>`;
  }

  function drawDie(team, value) {
    const stage = document.getElementById('dice-stage-' + team);
    stage.innerHTML = diceSVG(value, TEAM_INFO[team].color);
  }

  // Render starting "?" face on each die.
  function resetDiceFaces() {
    drawDie('A', 1);
    drawDie('B', 1);
    document.getElementById('dice-roll-A').textContent = '—';
    document.getElementById('dice-roll-B').textContent = '—';
    document.getElementById('initiative-result').textContent = '';
    document.getElementById('initiative-choose').style.display = 'none';
  }

  function rollInitiative() {
    if (state.initiative.animating) return;
    state.initiative.animating = true;
    document.getElementById('roll-btn').disabled = true;
    document.getElementById('initiative-choose').style.display = 'none';
    document.getElementById('initiative-result').textContent = '';

    const finalA = 1 + Math.floor(Math.random() * 6);
    const finalB = 1 + Math.floor(Math.random() * 6);

    // Tumble for ~900ms then settle on the rolled face.
    const start = Date.now();
    const dur = 900;
    const tick = () => {
      const t = Date.now() - start;
      if (t >= dur) {
        drawDie('A', finalA);
        drawDie('B', finalB);
        document.getElementById('dice-roll-A').textContent = finalA;
        document.getElementById('dice-roll-B').textContent = finalB;
        finishInitiative(finalA, finalB);
        return;
      }
      drawDie('A', 1 + Math.floor(Math.random() * 6));
      drawDie('B', 1 + Math.floor(Math.random() * 6));
      requestAnimationFrame(tick);
    };
    tick();
  }

  function finishInitiative(a, b) {
    state.initiative.a = a;
    state.initiative.b = b;
    document.getElementById('roll-btn').disabled = false;
    state.initiative.animating = false;

    const resultEl = document.getElementById('initiative-result');
    if (a === b) {
      resultEl.textContent = `Tie at ${a}. Re-roll.`;
      document.getElementById('roll-btn').textContent = 'Re-roll';
      return;
    }
    const winner = a > b ? 'A' : 'B';
    state.initiative.winner = winner;
    const winnerName = winner === 'A'
      ? (state.rosters.A.name || 'Player Blue')
      : (state.rosters.B.name || 'Player Red');
    resultEl.textContent = `${winnerName} wins initiative (${a} vs ${b}).`;
    document.getElementById('initiative-choose').style.display = '';
    document.getElementById('initiative-choose-prompt').textContent =
      `${winnerName} chooses who deploys first:`;
    document.getElementById('roll-btn').textContent = 'Re-roll';
  }

  document.getElementById('roll-btn').addEventListener('click', rollInitiative);
  document.getElementById('roll-back-btn').addEventListener('click', () => {
    setPhase('teams');
  });
  document.querySelectorAll('#initiative-choose [data-first]').forEach(btn => {
    btn.addEventListener('click', () => {
      const first = btn.dataset.first;
      startDeployment(first);
    });
  });

  // ── Phase 3: Deployment ──────────────────────────────────────────────
  // Each player deploys 1/3 of their roster, alternating, for 3 rounds.
  function planBatches(total) {
    if (total <= 0) return [0, 0, 0];
    let rem = total;
    const out = [];
    for (let i = 3; i > 0; i--) {
      const n = Math.ceil(rem / i);
      out.push(n);
      rem -= n;
    }
    return out;
  }

  function startDeployment(first) {
    const aTotal = state.units.filter(u => u.team === 'A').length;
    const bTotal = state.units.filter(u => u.team === 'B').length;
    state.deploy.first = first;
    state.deploy.currentTeam = first;
    state.deploy.batches.A = planBatches(aTotal);
    state.deploy.batches.B = planBatches(bTotal);
    state.deploy.placedCount.A = 0;
    state.deploy.placedCount.B = 0;
    state.deploy.round = 0;
    state.deploy.pendingUnit = null;
    setPhase('deploy');
    phaseChip.textContent = 'Deployment';
    endTurnBtn.style.display = 'none';
    log(`— Engagement begins on ${mapDef.name} —`, 'turn');
    log(`${state.deploy.first === 'A' ? (state.rosters.A.name || 'Player Blue') : (state.rosters.B.name || 'Player Red')} deploys first.`, 'turn');
    autoSelectNextUnit();
    // Wait for the layout pass after switching phases so the canvas picks up
    // its real width before we draw.
    requestAnimationFrame(render);
  }

  function deployBatchSize(team) {
    return state.deploy.batches[team][state.deploy.round] || 0;
  }
  function deployedThisBatch(team) {
    // Count placed units for the team and figure out how many of those belong
    // to the current batch.
    let placedSoFar = 0;
    for (let r = 0; r < state.deploy.round; r++) {
      placedSoFar += state.deploy.batches[team][r] || 0;
    }
    return state.deploy.placedCount[team] - placedSoFar;
  }
  function deployRemainingThisBatch(team) {
    return Math.max(0, deployBatchSize(team) - deployedThisBatch(team));
  }

  function autoSelectNextUnit() {
    if (state.phase !== 'deploy') return;
    const team = state.deploy.currentTeam;
    if (!team) return;
    const remainingThisBatch = deployRemainingThisBatch(team);
    if (remainingThisBatch <= 0) {
      advanceDeployTurn();
      return;
    }
    state.deploy.pendingUnit =
      state.units.find(u => u.team === team && !u.deployed) || null;
  }

  function advanceDeployTurn() {
    // Switch to the other team within the same round; if both have finished
    // the current batch, advance to the next round; if all rounds finished,
    // begin combat.
    const cur = state.deploy.currentTeam;
    const other = cur === 'A' ? 'B' : 'A';
    if (deployRemainingThisBatch(other) > 0) {
      state.deploy.currentTeam = other;
    } else {
      // Both done with this round.
      state.deploy.round += 1;
      if (state.deploy.round >= 3) {
        if (allUnitsDeployed()) return startCombat();
        // Edge case (rounding mismatch): keep rolling until empty.
      }
      // Reset to the player who was "first" for the new round.
      const aLeft = state.units.filter(u => u.team === 'A' && !u.deployed).length;
      const bLeft = state.units.filter(u => u.team === 'B' && !u.deployed).length;
      if (aLeft === 0 && bLeft === 0) return startCombat();
      state.deploy.currentTeam = aLeft > 0 && (state.deploy.first === 'A' || bLeft === 0)
        ? 'A'
        : 'B';
    }
    state.deploy.pendingUnit =
      state.units.find(u => u.team === state.deploy.currentTeam && !u.deployed) || null;
  }

  function allUnitsDeployed() {
    return state.units.every(u => u.deployed);
  }

  // Validate a placement: must be inside a deploy zone for the team and not
  // overlap walls or other units.
  function validDeployPoint(unit, x, y) {
    const r = unitRadiusMax(unit);
    if (x < r || y < r) return false;
    if (x > BOARD.width - r || y > BOARD.height - r) return false;
    if (!KT.inDeploySquare(mapDef, unit.team, x, y)) return false;
    if (unitOccupiesCircle(x, y, r, unit)) return false;
    if (overlapsWall(x, y, r)) return false;
    return true;
  }

  function overlapsWall(x, y, r) {
    for (const w of mapDef.walls || []) {
      const d = KT.geom.pointSegDist(x, y, w.x1, w.y1, w.x2, w.y2);
      if (d < r) return true;
    }
    return false;
  }

  function tryPlacePending(x, y) {
    const u = state.deploy.pendingUnit;
    if (!u) return false;
    if (!validDeployPoint(u, x, y)) return false;
    u.x = x;
    u.y = y;
    u.deployed = true;
    state.deploy.placedCount[u.team] += 1;
    log(`${state.rosters[u.team].name || TEAM_INFO[u.team].name} deploys ${u.letter} (${u._displayName}).`);
    if (deployRemainingThisBatch(u.team) <= 0) {
      advanceDeployTurn();
    } else {
      state.deploy.pendingUnit =
        state.units.find(o => o.team === u.team && !o.deployed) || null;
    }
    return true;
  }

  function selectPendingUnit(unit) {
    if (state.phase !== 'deploy') return;
    if (unit.deployed) return;
    if (unit.team !== state.deploy.currentTeam) return;
    state.deploy.pendingUnit = unit;
    render();
  }

  // Click on an already-deployed unit during deployment to undo it (only on
  // the current player's units, only if we've already placed at least one).
  function undeployUnit(unit) {
    if (state.phase !== 'deploy') return;
    if (!unit.deployed) return;
    if (unit.team !== state.deploy.currentTeam) return;
    if (deployedThisBatch(unit.team) <= 0) return;
    unit.deployed = false;
    unit.x = null;
    unit.y = null;
    state.deploy.placedCount[unit.team] -= 1;
    state.deploy.pendingUnit = unit;
    log(`${state.rosters[unit.team].name || TEAM_INFO[unit.team].name} recalls ${unit.letter}.`);
    render();
  }

  // ── Phase 4: Combat ──────────────────────────────────────────────────
  function startCombat() {
    state.phase = 'combat';
    state.combat.activeTeam = state.deploy.first; // initiative carries forward
    state.combat.turn = 1;
    state.combat.selectedId = null;
    state.combat.over = false;
    setPhase('combat');
    phaseChip.textContent = 'Battle';
    batchChip.style.display = 'none';
    endTurnBtn.style.display = '';
    log(`— Combat begins —`, 'turn');
    state.combat.selectedId =
      state.units.find(u => u.team === state.combat.activeTeam && u.alive) || null;
    requestAnimationFrame(render);
    if (activeTeam() === 'B') setTimeout(runAITurn, 500);
  }

  function selected() { return state.combat.selectedId; }
  function activeTeam() { return state.combat.activeTeam; }

  function unitAtPoint(x, y) {
    return state.units.find(u => u.deployed && u.alive
      && Math.hypot(u.x - x, u.y - y) <= unitRadiusMax(u) + 0.4);
  }

  function unitOccupiesCircle(x, y, r, ignore) {
    return state.units.find(u => u.deployed && u.alive && u !== ignore &&
      Math.hypot(u.x - x, u.y - y) < r + unitRadiusMax(u));
  }

  function moveCost(u, x, y) { return Math.hypot(x - u.x, y - u.y); }

  function canMoveTo(u, x, y) {
    const r = unitRadiusMax(u);
    if (x < r || y < r) return false;
    if (x > BOARD.width - r || y > BOARD.height - r) return false;
    if (moveCost(u, x, y) > MOVE_INCHES) return false;
    if (KT.geom.losBlocked(mapDef, u.x, u.y, x, y)) return false;
    if (unitOccupiesCircle(x, y, r, u)) return false;
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
      else if (t.type === 'rect' || t.type === 'sarcophagus') {
        r = Math.max(t.w || 1, t.h || 1) * 0.5;
      } else if (t.type === 'barricade') {
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
      if (!o.alive || !o.deployed || o.team === u.team) continue;
      const dist = Math.hypot(o.x - u.x, o.y - u.y);
      if (dist > SHOOT_RANGE_INCHES) continue;
      if (KT.geom.losBlocked(mapDef, u.x, u.y, o.x, o.y)) continue;
      out.push({ target: o, cover: shotCoverPenalty(u.x, u.y, o.x, o.y) });
    }
    return out;
  }

  function resolveShoot(attacker, defender, coverCount) {
    const hitChance = Math.max(0.1, BASE_HIT - COVER_PENALTY * coverCount);
    const hit = Math.random() < hitChance;
    if (!hit) {
      log(`${attacker.letter} fires at ${defender.letter} — miss.`);
      return;
    }
    const dmg = attacker.dmg + (Math.random() < 0.2 ? 1 : 0);
    defender.hp -= dmg;
    if (defender.hp <= 0) {
      defender.hp = 0; defender.alive = false;
      log(`${defender.letter} (${defender._displayName}) is slain by ${attacker.letter}.`, 'kill');
    } else {
      log(`${attacker.letter} hits ${defender.letter} for ${dmg}.`, 'hit');
    }
  }

  function afterAction() {
    const aAlive = state.units.some(u => u.team === 'A' && u.alive);
    const bAlive = state.units.some(u => u.team === 'B' && u.alive);
    if (!aAlive || !bAlive) {
      state.combat.over = true;
      state.phase = 'over';
      const winner = aAlive ? 'A' : 'B';
      const winnerName = state.rosters[winner].name || TEAM_INFO[winner].name;
      overlayTitle.textContent = `${winnerName} Victorious`;
      overlayText.textContent = aAlive
        ? 'Blue holds the field; Red lies broken.'
        : 'Red holds the field; Blue lies broken.';
      overlay.style.display = 'flex';
      return;
    }
    const u = selected();
    if (u && u.ap <= 0) {
      const next = state.units.find(o => o.alive && o.team === activeTeam() && o.ap > 0);
      state.combat.selectedId = next || null;
    }
  }

  function endTurn() {
    if (state.phase !== 'combat') return;
    state.combat.activeTeam = state.combat.activeTeam === 'A' ? 'B' : 'A';
    if (state.combat.activeTeam === state.deploy.first) state.combat.turn += 1;
    state.units.forEach(u => { if (u.alive) u.ap = MAX_AP; });
    state.combat.selectedId =
      state.units.find(u => u.alive && u.team === activeTeam()) || null;
    const teamName = state.rosters[activeTeam()].name || TEAM_INFO[activeTeam()].name;
    log(`— ${teamName} activation begins —`, 'turn');
    // The user always commands the Blue (A) team. Red is the AI opponent.
    if (activeTeam() === 'B') setTimeout(runAITurn, 350);
    render();
  }

  endTurnBtn.addEventListener('click', endTurn);

  // Simple AI: shoot the weakest visible target, otherwise close in.
  function runAITurn() {
    if (state.phase !== 'combat' || activeTeam() !== 'B') return;
    const aiTeam = activeTeam();
    const aiUnits = state.units.filter(u => u.alive && u.team === aiTeam);
    function step() {
      if (state.phase !== 'combat' || activeTeam() !== aiTeam) return;
      let didSomething = false;
      for (const u of aiUnits) {
        if (!u.alive || u.ap <= 0) continue;
        state.combat.selectedId = u;
        const targets = shootTargetsFor(u);
        if (targets.length) {
          targets.sort((a, b) => a.target.hp - b.target.hp);
          const t = targets[0];
          resolveShoot(u, t.target, t.cover);
          u.ap -= 1; didSomething = true; afterAction(); render();
          if (state.combat.over) return;
          break;
        }
        const enemies = state.units.filter(o => o.alive && o.team !== aiTeam);
        if (!enemies.length) break;
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
          log(`${u.letter} advances.`);
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

  // ── Logging & sidebar ────────────────────────────────────────────────
  function log(msg, cls) {
    if (!logEl) return;
    const p = document.createElement('p');
    p.className = 'entry' + (cls ? ' ' + cls : '');
    p.textContent = msg;
    logEl.appendChild(p);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function unitRowFor(u) {
    const ti = TEAM_INFO[u.team];
    const div = document.createElement('div');
    const isDeploying = state.phase === 'deploy';
    const isPending = isDeploying && state.deploy.pendingUnit === u;
    const isSelected = state.phase === 'combat' && state.combat.selectedId === u;
    div.className = 'unit-row'
      + (isSelected || isPending ? ' selected' : '')
      + (u.alive ? '' : ' dead');
    if (isDeploying && !u.deployed) div.classList.add('undeployed');
    div.innerHTML = `
      <div class="swatch" style="background:${ti.color};">${u.letter}</div>
      <div class="meta">
        <div class="name">${escapeHtml(u._displayName)}</div>
        <div class="stats"></div>
      </div>`;
    const statsEl = div.querySelector('.stats');
    if (state.phase === 'deploy') {
      statsEl.textContent = u.deployed
        ? `Deployed · Sv ${u.save}+ · W ${u.wounds}`
        : `Awaiting deploy · Sv ${u.save}+ · W ${u.wounds}`;
    } else {
      statsEl.textContent =
        `HP ${u.alive ? u.hp : 0}/${u.maxHp} · AP ${u.alive ? u.ap : 0}/${MAX_AP} · Sv ${u.save}+`;
    }

    // Hover preview the stat block on desktop. Click is the explicit action:
    //   - Deployment: click an active-team row to make it the pending unit
    //     (or recall it if already on the board).
    //   - Combat: click your own unit row to select it for orders.
    //   - Otherwise (enemy / dead during deployment): pin the stat block.
    div.addEventListener('mouseenter', () => showStatBlock(u, null));
    div.addEventListener('mouseleave', () => hideStatBlock());
    div.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.phase === 'deploy' && u.team === state.deploy.currentTeam) {
        if (u.deployed) undeployUnit(u);
        else selectPendingUnit(u);
        return;
      }
      if (state.phase === 'combat' && u.alive && u.team === activeTeam()) {
        state.combat.selectedId = u;
        render();
        return;
      }
      showStatBlock(u, null, true);
    });
    div.style.cursor = 'pointer';
    return div;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  }

  function renderSidebar() {
    teamAEl.innerHTML = '';
    teamBEl.innerHTML = '';
    state.units.filter(u => u.team === 'A').forEach(u => teamAEl.appendChild(unitRowFor(u)));
    state.units.filter(u => u.team === 'B').forEach(u => teamBEl.appendChild(unitRowFor(u)));

    const labelA = state.rosters.A
      ? `${state.rosters.A.name || 'Untitled'} · ${(FACTIONS_BY_ID[state.rosters.A.factionId] || {}).name || ''}`
      : 'Player Blue';
    const labelB = state.rosters.B
      ? `${state.rosters.B.name || 'Untitled'} · ${(FACTIONS_BY_ID[state.rosters.B.factionId] || {}).name || ''}`
      : 'Player Red';
    sidebarALabel.textContent = labelA;
    sidebarBLabel.textContent = labelB;
  }

  function renderHud() {
    if (state.phase === 'deploy') {
      phaseChip.textContent = 'Deployment';
      batchChip.style.display = '';
      const round = state.deploy.round + 1;
      batchChip.textContent = `Batch ${Math.min(round, 3)} of 3`;
      const team = state.deploy.currentTeam;
      const rname = team && state.rosters[team] ? (state.rosters[team].name || TEAM_INFO[team].name) : '';
      turnBanner.textContent = team ? `${rname} deploying` : 'Deployment';
      turnBanner.style.color = team ? TEAM_INFO[team].color : 'var(--accent-primary)';

      const remainingThis = team ? deployRemainingThisBatch(team) : 0;
      const totalThisBatch = team ? deployBatchSize(team) : 0;
      const placedThis = totalThisBatch - remainingThis;
      const pending = state.deploy.pendingUnit;
      let msg = `${rname} — placing ${placedThis + 1} of ${totalThisBatch} this batch.`;
      if (pending) msg += ` Tap inside the highlighted zone to deploy ${pending.letter} (${pending._displayName}).`;
      deployStatus.textContent = msg;
      deployStatus.style.display = '';
    } else if (state.phase === 'combat' || state.phase === 'over') {
      phaseChip.textContent = `Turn ${state.combat.turn}`;
      batchChip.style.display = '';
      const u = selected();
      batchChip.textContent = u ? `AP ${u.ap}/${MAX_AP}` : 'AP —';
      const team = activeTeam();
      const rname = state.rosters[team] ? (state.rosters[team].name || TEAM_INFO[team].name) : TEAM_INFO[team].name;
      turnBanner.textContent = `${rname} activation`;
      turnBanner.style.color = TEAM_INFO[team].color;
      deployStatus.style.display = 'none';
    }
  }

  // ── Stat block popup ─────────────────────────────────────────────────
  function showStatBlock(u, evt, pinned) {
    if (!u) { hideStatBlock(); return; }
    state.hoverUnit = u;
    if (pinned) state.pinnedStatUnit = u;

    const f = FACTIONS_BY_ID[u.factionId];
    const factionName = f ? f.name : '';
    const ranged = (u.weapons || []).filter(w => !w.is_melee);
    const melee  = (u.weapons || []).filter(w =>  w.is_melee);
    function weaponLine(w) {
      const tag = w.is_melee ? 'melee' : (w.is_pistol ? 'pistol' : 'ranged');
      const rules = (w.rules && w.rules.length) ? `<span class="sb-rules">${escapeHtml(w.rules.join(' · '))}</span>` : '';
      return `<div class="sb-weapon">
        <div class="sb-weapon-head"><span class="sb-w-name">${escapeHtml(w.name)}</span><span class="sb-w-tag">${tag}</span></div>
        <div class="sb-weapon-stats">A${w.atk} · ${w.hit}+ · ${w.normal_dmg}/${w.crit_dmg}</div>
        ${rules}
      </div>`;
    }
    const rangedHTML = ranged.length ? ranged.map(weaponLine).join('') : '<div class="sb-weapon-empty">No ranged profile.</div>';
    const meleeHTML  = melee.length  ? melee.map(weaponLine).join('')  : '<div class="sb-weapon-empty">No melee profile.</div>';
    const loadout = [];
    if (u.rangedChoice) loadout.push('Ranged: ' + u.rangedChoice);
    if (u.meleeChoice)  loadout.push('Melee: '  + u.meleeChoice);

    const teamColor = TEAM_INFO[u.team].color;
    const hpLine = (state.phase === 'combat' || state.phase === 'over')
      ? `<div class="sb-stat"><span>HP</span><strong>${u.alive ? u.hp : 0} / ${u.maxHp}</strong></div>`
      : `<div class="sb-stat"><span>W</span><strong>${u.wounds}</strong></div>`;
    statBlockEl.innerHTML = `
      <div class="sb-head" style="border-color:${teamColor};">
        <div class="sb-letter" style="background:${teamColor};">${u.letter}</div>
        <div>
          <div class="sb-name">${escapeHtml(u._displayName)}</div>
          <div class="sb-faction">${escapeHtml(factionName)}</div>
        </div>
        ${pinned ? '<button class="sb-close" type="button" aria-label="Close">×</button>' : ''}
      </div>
      <div class="sb-stats-row">
        <div class="sb-stat"><span>SAVE</span><strong>${u.save}+</strong></div>
        ${hpLine}
        <div class="sb-stat"><span>APL</span><strong>${u.apl}</strong></div>
        <div class="sb-stat"><span>M</span><strong>${escapeHtml(u.move || '—')}</strong></div>
      </div>
      ${loadout.length ? `<div class="sb-loadout">${escapeHtml(loadout.join(' · '))}</div>` : ''}
      <div class="sb-section-label">Ranged</div>
      <div class="sb-weapons">${rangedHTML}</div>
      <div class="sb-section-label">Melee</div>
      <div class="sb-weapons">${meleeHTML}</div>
    `;
    statBlockEl.style.display = '';
    statBlockEl.classList.toggle('pinned', !!pinned);
    if (pinned) {
      statBlockEl.querySelector('.sb-close')?.addEventListener('click', (e) => {
        e.stopPropagation(); hideStatBlock(true);
      });
    }
    positionStatBlock(evt, u);
  }

  function positionStatBlock(evt, u) {
    // Anchor to the canvas if we have a unit on the board, else to mouse evt.
    const margin = 12;
    let cx, cy;
    if (u && u.deployed && u.x != null) {
      const rect = canvas.getBoundingClientRect();
      cx = rect.left + (u.x / BOARD.width) * rect.width;
      cy = rect.top  + (u.y / BOARD.height) * rect.height;
    } else if (evt) {
      cx = evt.clientX; cy = evt.clientY;
    } else {
      cx = window.innerWidth - 320; cy = 100;
    }
    const sb = statBlockEl;
    sb.style.left = '0px';
    sb.style.top = '0px';
    const sw = sb.offsetWidth || 280;
    const sh = sb.offsetHeight || 200;
    let left = cx + margin;
    let top  = cy + margin;
    if (left + sw + 8 > window.innerWidth)  left = Math.max(8, cx - sw - margin);
    if (top  + sh + 8 > window.innerHeight) top  = Math.max(8, cy - sh - margin);
    sb.style.left = left + 'px';
    sb.style.top  = top  + 'px';
  }

  function hideStatBlock(force) {
    if (!force && state.pinnedStatUnit) return;
    state.hoverUnit = null;
    if (force) state.pinnedStatUnit = null;
    statBlockEl.style.display = 'none';
    statBlockEl.classList.remove('pinned');
  }

  // ── Rendering (canvas) ──────────────────────────────────────────────
  function fitCanvas() {
    const w = canvas.clientWidth;
    const aspect = BOARD.width / BOARD.height;
    canvas.style.height = (w / aspect) + 'px';
    if (canvas.width !== Math.round(w * devicePixelRatio)) {
      canvas.width  = Math.round(w * devicePixelRatio);
      canvas.height = Math.round((w / aspect) * devicePixelRatio);
    }
  }

  function drawBoard() {
    fitCanvas();
    const W = canvas.width, H = canvas.height;
    const s = W / BOARD.width;

    ctx.fillStyle = '#0f0b09';
    ctx.fillRect(0, 0, W, H);

    // Per-team half-board fills (subtle).
    const aZone = KT.deployZone(mapDef, 'A');
    const bZone = KT.deployZone(mapDef, 'B');
    ctx.fillStyle = 'rgba(58, 109, 184, 0.10)';
    ctx.fillRect(aZone.x * s, aZone.y * s, aZone.w * s, aZone.h * s);
    ctx.fillStyle = 'rgba(184, 32, 58, 0.10)';
    ctx.fillRect(bZone.x * s, bZone.y * s, bZone.w * s, bZone.h * s);

    // Authored deploy squares — strong fill during deployment so the active
    // player sees exactly where they can place; muted otherwise.
    const dz = mapDef.deployZones || [];
    for (const z of dz) {
      const isCurrent = state.phase === 'deploy' && z.team === state.deploy.currentTeam;
      const tinted = z.team === 'A' ? '58, 109, 184' : '184, 32, 58';
      ctx.fillStyle = `rgba(${tinted}, ${isCurrent ? 0.42 : 0.18})`;
      ctx.fillRect(z.x * s, z.y * s, z.w * s, z.h * s);
      if (isCurrent) {
        ctx.strokeStyle = `rgba(${tinted}, 0.95)`;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(z.x * s + 1, z.y * s + 1, z.w * s - 2, z.h * s - 2);
        ctx.setLineDash([]);
      }
    }

    // Grid (4")
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= BOARD.width; x += BOARD.gridSize) {
      ctx.beginPath(); ctx.moveTo(x * s, 0); ctx.lineTo(x * s, H); ctx.stroke();
    }
    for (let y = 0; y <= BOARD.height; y += BOARD.gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y * s); ctx.lineTo(W, y * s); ctx.stroke();
    }

    // Dashed deployment divider
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

    // Legacy walls
    ctx.strokeStyle = '#0a0706';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const w of mapDefRaw.walls || []) {
      ctx.beginPath();
      ctx.moveTo(w.x1 * s, w.y1 * s);
      ctx.lineTo(w.x2 * s, w.y2 * s);
      ctx.stroke();
    }

    // Perimeter
    ctx.strokeRect(2, 2, W - 4, H - 4);

    // Legacy terrain
    for (const t of mapDefRaw.terrain || []) drawTerrain(t, s);

    // Pieces (walls + decorations + terrain)
    for (const p of mapDefRaw.pieces || []) KT.drawPieceCanvas(ctx, p, s, s);

    // Objectives
    for (const o of mapDef.objectives || []) {
      const fill = o.owner === 'A' ? '#3a6db8' : (o.owner === 'B' ? '#b8203a' : '#d6c8a4');
      const ring = o.owner === 'A' ? '#fff' : (o.owner === 'B' ? '#fff' : '#0a0706');
      ctx.fillStyle = fill;
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(o.x * s, o.y * s, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Deployment hover preview — draw the pending unit ghost at hoverPt.
    if (state.phase === 'deploy' && state.combat.hoverPt && state.deploy.pendingUnit) {
      const u = state.deploy.pendingUnit;
      const p = state.combat.hoverPt;
      const ok = validDeployPoint(u, p.x, p.y);
      drawUnitShape(u, p.x * s, p.y * s, s, { ghost: true, ok });
    }

    // Movement preview (combat)
    if (state.phase === 'combat') {
      const u = selected();
      if (u && u.alive && u.ap > 0 && u.team === activeTeam()) {
        ctx.strokeStyle = 'rgba(201,167,77,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(u.x * s, u.y * s, MOVE_INCHES * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        if (state.combat.hoverPt) {
          const ok = canMoveTo(u, state.combat.hoverPt.x, state.combat.hoverPt.y);
          ctx.strokeStyle = ok ? 'rgba(201,167,77,0.95)' : 'rgba(184,32,58,0.85)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(u.x * s, u.y * s);
          ctx.lineTo(state.combat.hoverPt.x * s, state.combat.hoverPt.y * s);
          ctx.stroke();
          const { rx, ry } = unitRadii(u);
          ctx.beginPath();
          ctx.ellipse(state.combat.hoverPt.x * s, state.combat.hoverPt.y * s, rx * s, ry * s, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Units
    for (const u of state.units) {
      if (!u.deployed) continue;
      drawUnitShape(u, u.x * s, u.y * s, s, {
        selected: state.phase === 'combat' && state.combat.selectedId === u,
        pending:  state.phase === 'deploy'  && state.deploy.pendingUnit === u,
      });
    }
  }

  function drawUnitShape(u, cx, cy, s, opts) {
    const ti = TEAM_INFO[u.team];
    const { rx, ry } = unitRadii(u);
    const sx = rx * s, sy = ry * s;
    const ghost = opts && opts.ghost;
    const ok = !opts || opts.ok !== false;

    ctx.save();
    if (ghost) ctx.globalAlpha = 0.55;

    // Drop shadow
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(cx + 1, cy + 2, sx, sy, 0, 0, Math.PI * 2); ctx.fill();

    // Base fill
    ctx.fillStyle = ghost
      ? (ok ? 'rgba(201,167,77,0.65)' : 'rgba(184,32,58,0.55)')
      : (u.alive ? ti.color : '#3a302a');
    ctx.beginPath(); ctx.ellipse(cx, cy, sx, sy, 0, 0, Math.PI * 2); ctx.fill();

    // Rim
    ctx.strokeStyle = ti.accent;
    ctx.lineWidth = 1.5; ctx.stroke();

    if ((opts && opts.selected) || (opts && opts.pending)) {
      ctx.strokeStyle = '#fff8e0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, sx + 4, sy + 4, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Letter code
    if (!ghost) {
      const r = Math.min(sx, sy);
      const fontSize = Math.max(10, Math.round(r * 1.2));
      ctx.fillStyle = ti.text;
      ctx.font = `bold ${fontSize}px Oswald, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(u.letter || '?', cx, cy + 1);
    }

    // HP bar (combat only)
    if (state.phase === 'combat' || state.phase === 'over') {
      if (!ghost && u.alive) {
        const hpPct = u.hp / u.maxHp;
        const barW = sx * 2.4, bx = cx - barW / 2, by = cy + sy + 4;
        ctx.fillStyle = '#000'; ctx.fillRect(bx - 1, by - 1, barW + 2, 5);
        ctx.fillStyle = '#3a302a'; ctx.fillRect(bx, by, barW, 3);
        ctx.fillStyle = hpPct > 0.5 ? '#c9a74d' : (hpPct > 0.25 ? '#e68a6a' : '#b8203a');
        ctx.fillRect(bx, by, barW * hpPct, 3);
      }
    }

    ctx.restore();
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

  function render() {
    if (state.phase === 'deploy' || state.phase === 'combat' || state.phase === 'over') {
      drawBoard();
    }
    renderSidebar();
    renderHud();
  }

  // ── Input ────────────────────────────────────────────────────────────
  function eventToBoard(evt) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((evt.clientX - rect.left) / rect.width) * BOARD.width,
      y: ((evt.clientY - rect.top) / rect.height) * BOARD.height,
    };
  }

  canvas.addEventListener('mousemove', (evt) => {
    state.combat.hoverPt = eventToBoard(evt);
    if (state.phase === 'combat' || state.phase === 'deploy') {
      const p = state.combat.hoverPt;
      const u = unitAtPoint(p.x, p.y);
      if (u) showStatBlock(u, evt);
      else if (!state.pinnedStatUnit) hideStatBlock();
      drawBoard();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    state.combat.hoverPt = null;
    if (!state.pinnedStatUnit) hideStatBlock();
    if (state.phase === 'deploy' || state.phase === 'combat') drawBoard();
  });

  canvas.addEventListener('click', (evt) => {
    const p = eventToBoard(evt);

    if (state.phase === 'deploy') {
      const clicked = unitAtPoint(p.x, p.y);
      if (clicked) {
        // Tap on an already-placed unit: pin its stat block; if it's ours
        // and on the active team, also offer a "recall" via long-tap (we
        // simply recall on same-team click when nothing is pending).
        if (clicked.team === state.deploy.currentTeam) {
          if (state.deploy.pendingUnit && !state.deploy.pendingUnit.deployed) {
            // Show stat block — placement intent dominates.
            showStatBlock(clicked, evt, true);
          } else {
            undeployUnit(clicked);
          }
        } else {
          showStatBlock(clicked, evt, true);
        }
        return;
      }
      // Empty board click = attempt placement.
      const placed = tryPlacePending(p.x, p.y);
      if (placed) {
        // After placement, autoSelectNextUnit may already have fired; ensure
        // we have a pending unit if any are left for the current team.
        if (!state.deploy.pendingUnit) autoSelectNextUnit();
        if (allUnitsDeployed()) startCombat();
        else render();
      }
      return;
    }

    if (state.phase === 'combat' && !state.combat.over) {
      const clicked = unitAtPoint(p.x, p.y);
      const u = selected();
      if (clicked && clicked.alive) {
        if (clicked.team === activeTeam()) {
          state.combat.selectedId = clicked;
          render();
        } else {
          // Tap enemy: stat block; or shoot if we have AP and LOS.
          if (u && u.team === activeTeam() && u.alive && u.ap > 0) {
            const list = shootTargetsFor(u);
            const t = list.find(t => t.target === clicked);
            if (t) {
              resolveShoot(u, clicked, t.cover);
              u.ap -= 1;
              afterAction();
              render();
              return;
            }
          }
          showStatBlock(clicked, evt, true);
        }
        return;
      }
      if (!u || u.team !== activeTeam() || !u.alive || u.ap <= 0) return;
      if (canMoveTo(u, p.x, p.y)) {
        const d = moveCost(u, p.x, p.y);
        u.x = p.x; u.y = p.y;
        u.ap -= 1;
        log(`${u.letter} repositions ${d.toFixed(1)}".`);
        afterAction();
        render();
      }
    }
  });

  // Tap outside the stat block dismisses it (mobile).
  document.addEventListener('click', (evt) => {
    if (!state.pinnedStatUnit) return;
    if (statBlockEl.contains(evt.target)) return;
    if (canvas.contains(evt.target)) return;
    hideStatBlock(true);
  });

  // ── Restart / nav ────────────────────────────────────────────────────
  document.getElementById('restart-btn').addEventListener('click', () => {
    // Wipe everything except the chosen map; jump back to team picker.
    state.units = [];
    state.rosters.A = null;
    state.rosters.B = null;
    state.initiative = { a: null, b: null, winner: null, animating: false };
    state.deploy = {
      first: null, currentTeam: null,
      batches: { A: [], B: [] }, placedCount: { A: 0, B: 0 }, round: 0,
      pendingUnit: null,
    };
    state.combat = { turn: 1, activeTeam: 'A', selectedId: null, hoverPt: null, over: false };
    state.phase = 'teams';
    document.getElementById('confirm-teams').disabled = true;
    document.querySelectorAll('.roster-pick-card').forEach(c => c.classList.remove('selected'));
    document.getElementById('roster-summary-A').textContent = 'No team chosen.';
    document.getElementById('roster-summary-B').textContent = 'No team chosen.';
    overlay.style.display = 'none';
    setPhase('teams');
  });

  // ── Init ─────────────────────────────────────────────────────────────
  resetDiceFaces();
  syncDiceLabels();
  renderTeamPicker();
  setPhase('teams');

  window.addEventListener('resize', () => {
    if (state.phase === 'deploy' || state.phase === 'combat' || state.phase === 'over') {
      render();
    }
    if (state.pinnedStatUnit || state.hoverUnit) positionStatBlock(null, state.pinnedStatUnit || state.hoverUnit);
  });
})();
