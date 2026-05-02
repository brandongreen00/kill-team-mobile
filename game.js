(() => {
  const KT = window.KT;
  const FACTIONS = window.FACTIONS || [];
  const BOARD = KT.TOMB_BOARD;

  // ── Constants ────────────────────────────────────────────────────────
  // Most numbers come from window.KT_RULES.constants (rules.js); the few left
  // here are visual / geometry-only.
  const KTR = window.KT_RULES;
  const RC = KTR.constants;
  const MM_PER_INCH = 25.4;
  const DEFAULT_BASE_MM = 28;
  const COVER_PIECE_RADIUS = 1.2;        // visual fall-back for legacy maps

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
  // Some environments (file:// in headless tests) reject sessionStorage; fall
  // back to the default tomb-1 map silently in that case.
  let mapId = 'tomb-1';
  try { mapId = sessionStorage.getItem('kt.mapId') || 'tomb-1'; } catch (e) {}
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
      const moveInches = KTR.parseMoveStat(op.move);
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
        apl: op.apl || 2,
        move: op.move,
        moveInches,
        base: op.base || { d: DEFAULT_BASE_MM },
        weapons,
        keywords: op.keywords || [],
        // mechanics
        hp: op.wounds,
        maxHp: op.wounds,
        ap: op.apl || 2,
        alive: true,
        deployed: false,
        // turn / activation state
        unitState: 'ready',     // ready | activating | activated | incapacitated
        order: null,            // engage | conceal (set on activation)
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
      turningPoint: 1,
      initiativeTeam: 'A',         // who chose first this TP
      activeTeam: 'A',             // whose pick of ready unit is next
      selectedId: null,            // unit currently selected (pre-activation hover or active)
      activation: null,            // see startActivation()
      pendingMove: null,           // {kind, maxInches, dashed?} when waiting for click destination
      shoot: null,                 // shoot modal state
      fight: null,                 // fight modal state
      pieceState: { open: new Set() },  // pieceIndex of opened hatchways/breaches
      hoverPt: null,
      over: false,
    },

    // ── VP scoring ──
    // Two ops are tracked:
    //  • Kill Op   — cumulative VP (max 5) looked up from KILL_GRADE_TABLE
    //                using the number of enemy operatives a team has
    //                incapacitated vs. the enemy's starting roster size.
    //  • Crit Op   — 1 VP per objective whose combined APL of operatives
    //                within 1" exceeds the opposing team's, scored at the
    //                end of every turning point. Cumulative across the game.
    score: {
      killOp:    { A: 0, B: 0 },
      critOp:    { A: 0, B: 0 },
      kills:     { A: 0, B: 0 },     // # enemies this team has incapacitated
      startSize: { A: 0, B: 0 },     // enemy starting size at game start
      lastScoredTP: 0,               // guards crit-op against double-scoring
    },

    hoverUnit: null,                 // for the stat block popup
    pinnedStatUnit: null,            // tap-pinned (mobile)
  };

  // ── Kill Op lookup table (per the official Approved Ops chart) ─────
  // KILL_GRADE_TABLE[startingSize] = thresholds for kill grades 1..5.
  // Example: starting size 10, you need 2/4/6/8/10 kills for VP 1/2/3/4/5.
  const KILL_GRADE_TABLE = {
    5:  [1, 2, 3, 4, 5],
    6:  [1, 2, 4, 5, 6],
    7:  [1, 3, 4, 6, 7],
    8:  [2, 3, 5, 6, 8],
    9:  [2, 4, 5, 7, 9],
    10: [2, 4, 6, 8, 10],
    11: [2, 4, 7, 9, 11],
    12: [2, 5, 7, 10, 12],
    13: [3, 5, 8, 10, 13],
    14: [3, 6, 8, 11, 14],
  };

  function killOpVP(kills, startingSize) {
    if (kills <= 0 || startingSize <= 0) return 0;
    // Clamp to the table range — rosters of <5 use the 5-row, >14 use the 14-row.
    const N = Math.min(14, Math.max(5, startingSize));
    const thresholds = KILL_GRADE_TABLE[N];
    let vp = 0;
    for (let i = 0; i < 5; i++) {
      if (kills >= thresholds[i]) vp = i + 1;
    }
    return vp;
  }

  function recomputeKillOp() {
    ['A', 'B'].forEach(team => {
      const enemy = team === 'A' ? 'B' : 'A';
      state.score.killOp[team] = killOpVP(state.score.kills[team], state.score.startSize[enemy]);
    });
  }

  // Returns 'A' | 'B' | 'neutral' depending on which team's combined APL
  // among operatives within 1" of the marker is greater. Ties are neutral.
  function objectiveControl(obj) {
    let aSum = 0, bSum = 0;
    for (const u of state.units) {
      if (!u.alive || !u.deployed) continue;
      const d = Math.hypot(u.x - obj.x, u.y - obj.y);
      if (d <= RC.ENGAGEMENT_RANGE + 1e-3) {
        if (u.team === 'A') aSum += (u.apl || 0);
        else                bSum += (u.apl || 0);
      }
    }
    if (aSum > bSum) return 'A';
    if (bSum > aSum) return 'B';
    return 'neutral';
  }

  // Score the round that just ended. Awards 1 VP per controlled objective.
  // Guarded so a single TP can never score twice (covers the case where the
  // game ends mid-TP via elimination).
  function scoreCritOpEndOfTurn() {
    const tp = state.combat.turningPoint;
    if (state.score.lastScoredTP >= tp) return;
    state.score.lastScoredTP = tp;
    let aGained = 0, bGained = 0;
    for (const o of (mapDef.objectives || [])) {
      const c = objectiveControl(o);
      if (c === 'A') aGained++;
      else if (c === 'B') bGained++;
    }
    state.score.critOp.A += aGained;
    state.score.critOp.B += bGained;
    if (aGained || bGained) {
      log(`— TP ${tp} crit op: Blue +${aGained}, Red +${bGained} —`, 'turn');
    }
  }

  function totalVP(team) {
    return (state.score.killOp[team] || 0) + (state.score.critOp[team] || 0);
  }

  // Called whenever an enemy is incapacitated. `killerTeam` is the team that
  // scored the kill (i.e. the opposing side from the operative who fell).
  function registerKill(killerTeam) {
    if (killerTeam !== 'A' && killerTeam !== 'B') return;
    state.score.kills[killerTeam] = (state.score.kills[killerTeam] || 0) + 1;
    recomputeKillOp();
  }

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
  const vpBoardEl = document.getElementById('vp-board');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayText = document.getElementById('overlay-text');
  const statBlockEl = document.getElementById('stat-block');
  const activationPanel = document.getElementById('activation-panel');
  const activationWho = document.getElementById('activation-who');
  const activationMeta = document.getElementById('activation-meta');
  const activationOrders = document.getElementById('activation-orders');
  const activationActions = document.getElementById('activation-actions');
  const actionGrid = document.getElementById('action-grid');
  const undoBtn = document.getElementById('undo-btn');
  const endActivationBtn = document.getElementById('end-activation-btn');
  const activationHint = document.getElementById('activation-hint');
  const shootModal = document.getElementById('shoot-modal');
  const shootBody = document.getElementById('shoot-body');
  const shootCancel = document.getElementById('shoot-cancel');
  const fightModal = document.getElementById('fight-modal');
  const fightBody = document.getElementById('fight-body');
  const fightCancel = document.getElementById('fight-cancel');
  const targetPicker = document.getElementById('target-picker');

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

  // ── Phase 4: Combat (Turning Points + Activations) ───────────────────
  // Each Turning Point:
  //   1. Strategy/Initiative: in this PR we carry initiative from deployment
  //      forwards; future patches will add a roll-off.
  //   2. Ready: every alive operative resets state='ready' and ap=apl.
  //   3. Firefight: alternating activations. Each activation, the active
  //      player picks one of their ready operatives, declares an order
  //      (Engage / Conceal), spends AP on actions, and ends the activation.
  //
  // Mid-activation actions can be undone until End Activation is pressed.

  function teamName(t) { return state.rosters[t] ? (state.rosters[t].name || TEAM_INFO[t].name) : TEAM_INFO[t].name; }
  function selected() { return state.combat.selectedId; }
  function activeTeam() { return state.combat.activeTeam; }
  function activation() { return state.combat.activation; }

  function readyUnits(team) {
    return state.units.filter(u => u.team === team && u.alive && u.deployed && u.unitState === 'ready');
  }

  function unitAtPoint(x, y) {
    return state.units.find(u => u.deployed && u.alive
      && Math.hypot(u.x - x, u.y - y) <= unitRadiusMax(u) + 0.4);
  }

  function unitOccupiesCircle(x, y, r, ignore) {
    return state.units.find(u => u.deployed && u.alive && u !== ignore &&
      Math.hypot(u.x - x, u.y - y) < r + unitRadiusMax(u));
  }

  // Walls currently in effect (closed hatchways/breaches plus permanent walls).
  function effectiveWalls() {
    return KTR.effectiveWalls(mapDef, state.combat.pieceState.open);
  }
  function losBlocked(x1, y1, x2, y2) {
    return KTR.losBlockedByWalls(mapDef, state.combat.pieceState.open, x1, y1, x2, y2);
  }

  function startCombat() {
    state.phase = 'combat';
    state.combat.over = false;
    state.combat.turningPoint = 1;
    state.combat.pieceState = { open: new Set() };
    state.combat.activation = null;
    state.combat.pendingMove = null;
    state.combat.shoot = null;
    state.combat.fight = null;
    // Snapshot starting roster sizes for Kill Op lookups.
    state.score = {
      killOp: { A: 0, B: 0 },
      critOp: { A: 0, B: 0 },
      kills:  { A: 0, B: 0 },
      startSize: {
        A: state.units.filter(u => u.team === 'A').length,
        B: state.units.filter(u => u.team === 'B').length,
      },
      lastScoredTP: 0,
    };
    // For now initiative carries forward from deployment.
    state.combat.initiativeTeam = state.deploy.first;
    state.combat.activeTeam = state.deploy.first;
    state.units.forEach(u => {
      if (u.alive) { u.unitState = 'ready'; u.order = null; u.ap = u.apl; }
    });
    setPhase('combat');
    phaseChip.textContent = 'Turning Point 1';
    batchChip.style.display = '';
    endTurnBtn.style.display = 'none';
    log(`— Turning Point 1 begins —`, 'turn');
    log(`${teamName(state.combat.activeTeam)} activates first.`, 'turn');
    state.combat.selectedId = readyUnits(state.combat.activeTeam)[0] || null;
    syncActivationPanel();
    requestAnimationFrame(render);
  }

  function startActivation(unit) {
    if (!unit || unit.unitState !== 'ready') return;
    if (unit.team !== activeTeam()) return;
    unit.unitState = 'activating';
    unit.ap = unit.apl;
    unit.order = null;
    state.combat.selectedId = unit;
    state.combat.activation = {
      unit,
      order: null,
      ap: unit.apl,
      apMax: unit.apl,
      history: [],
      undoStack: [],
      hasReposition: false,
      hasDashed: false,
      hasCharged: false,
      hasFallenBack: false,
      hasShot: false,
      hasFought: false,
      teleportedThisActivation: false,
      // baseline snapshot so the user can undo back to "before this activation".
      baseline: null,
    };
    state.combat.activation.baseline = snapshotForUndo();
    log(`${teamName(unit.team)} activates ${unit.letter} (${unit._displayName}).`, 'turn');
    state.combat.pendingMove = null;
    syncActivationPanel();
    render();
  }

  function pickOrder(order) {
    const a = activation();
    if (!a) return;
    if (a.order) return; // can't change once chosen
    a.order = order;
    a.unit.order = order;
    log(`${a.unit.letter} declares ${order === 'engage' ? 'Engage' : 'Conceal'}.`);
    syncActivationPanel();
    render();
  }

  // ── Undo ───────────────────────────────────────────────────────────
  // Each action takes a snapshot of mutable state before applying. Undo
  // restores the most recent snapshot. Undo is only available for the
  // current activation.
  function snapshotForUndo() {
    const a = activation();
    return {
      units: state.units.map(u => ({
        x: u.x, y: u.y, hp: u.hp, alive: u.alive, ap: u.ap,
        unitState: u.unitState, order: u.order,
      })),
      open: new Set(state.combat.pieceState.open),
      activeTeam: state.combat.activeTeam,
      a: a ? {
        order: a.order, ap: a.ap,
        hasReposition: a.hasReposition, hasDashed: a.hasDashed,
        hasCharged: a.hasCharged, hasFallenBack: a.hasFallenBack,
        hasShot: a.hasShot, hasFought: a.hasFought,
        teleportedThisActivation: a.teleportedThisActivation,
        history: [...a.history],
      } : null,
    };
  }
  function pushUndo() {
    const a = activation();
    if (!a) return;
    a.undoStack.push(snapshotForUndo());
  }
  function applyUndo() {
    const a = activation();
    if (!a || a.undoStack.length === 0) return;
    const snap = a.undoStack.pop();
    state.units.forEach((u, i) => {
      const s = snap.units[i];
      u.x = s.x; u.y = s.y; u.hp = s.hp; u.alive = s.alive; u.ap = s.ap;
      u.unitState = s.unitState; u.order = s.order;
    });
    state.combat.pieceState.open = snap.open;
    state.combat.activeTeam = snap.activeTeam;
    if (snap.a && a) Object.assign(a, snap.a);
    state.combat.pendingMove = null;
    log(`Undo: reverted last action.`);
    syncActivationPanel();
    render();
  }

  function endActivation() {
    const a = activation();
    if (!a) return;
    if (!a.order) {
      activationHint.textContent = 'Pick an order before ending the activation.';
      activationHint.classList.add('warn');
      return;
    }
    const u = a.unit;
    u.unitState = 'activated';
    log(`${u.letter} ends activation.`, 'turn');
    state.combat.activation = null;
    state.combat.pendingMove = null;
    // Switch active team if the other has ready units; otherwise keep current.
    const cur = u.team;
    const other = cur === 'A' ? 'B' : 'A';
    if (readyUnits(other).length > 0) state.combat.activeTeam = other;
    else if (readyUnits(cur).length > 0) state.combat.activeTeam = cur;
    else { nextTurningPoint(); return; }
    state.combat.selectedId = readyUnits(state.combat.activeTeam)[0] || null;
    if (checkVictory()) return;
    syncActivationPanel();
    render();
  }

  function nextTurningPoint() {
    // Score the round that just ended before advancing the turning point.
    scoreCritOpEndOfTurn();
    state.combat.turningPoint++;
    const tp = state.combat.turningPoint;
    log(`— Turning Point ${tp} begins —`, 'turn');
    state.combat.activeTeam = state.combat.initiativeTeam;
    state.units.forEach(u => {
      if (u.alive) { u.unitState = 'ready'; u.order = null; u.ap = u.apl; }
    });
    state.combat.selectedId = readyUnits(state.combat.activeTeam)[0] || null;
    if (checkVictory()) return;
    syncActivationPanel();
    render();
  }

  function checkVictory() {
    const aAlive = state.units.some(u => u.team === 'A' && u.alive);
    const bAlive = state.units.some(u => u.team === 'B' && u.alive);
    if (aAlive && bAlive) return false;
    // Score crit op for the in-progress round before the game closes out.
    scoreCritOpEndOfTurn();
    state.combat.over = true;
    state.phase = 'over';
    state.combat.activation = null;
    const aVP = totalVP('A'), bVP = totalVP('B');
    let winner;
    if (!aAlive && !bAlive) winner = aVP >= bVP ? 'A' : 'B';
    else winner = aAlive ? 'A' : 'B';
    overlayTitle.textContent = `${teamName(winner)} Victorious`;
    const fieldLine = aAlive
      ? 'Blue holds the field; Red lies broken.'
      : (bAlive ? 'Red holds the field; Blue lies broken.' : 'Both forces are broken.');
    overlayText.textContent = `${fieldLine} Final VP — Blue ${aVP} · Red ${bVP}.`;
    overlay.style.display = 'flex';
    syncActivationPanel();
    render();
    return true;
  }

  // ── Movement validation ───────────────────────────────────────────
  // Movement actions consume a budget of inches across one-or-more legs of a
  // path. The active player traces the path waypoint-by-waypoint; each leg
  // must clear walls and respect the action-specific control-range rules:
  //   * Reposition / Dash: no leg may pass within 1" of an enemy operative.
  //   * Charge: legs may enter enemy CR; the END must be in CR of an enemy.
  //   * Fall Back: legs may enter / leave enemy CR; the END must NOT be in CR.

  function pathEnemyList(u) {
    return state.units.filter(o => o.alive && o.deployed && o.team !== u.team);
  }

  // Reason a fresh leg from (fromX, fromY) → (toX, toY) is invalid for the
  // currently armed move, or null if it's allowed.
  function canExtendPathReason(u, pm, toX, toY) {
    const r = unitRadiusMax(u);
    if (toX < r || toY < r || toX > BOARD.width - r || toY > BOARD.height - r) {
      return 'Off-board.';
    }
    const last = pm.waypoints[pm.waypoints.length - 1];
    const segDist = Math.hypot(toX - last.x, toY - last.y);
    if (pm.used + segDist > pm.maxInches + 1e-3) {
      return `Beyond move budget (${(pm.used + segDist).toFixed(1)}" > ${pm.maxInches.toFixed(1)}").`;
    }
    if (losBlocked(last.x, last.y, toX, toY)) return 'Leg crosses a wall.';
    if (unitOccupiesCircle(toX, toY, r, u)) return 'Waypoint occupied.';
    // Enemy control range along the leg.
    if (pm.kind === 'reposition' || pm.kind === 'dash') {
      for (const e of pathEnemyList(u)) {
        const d = KTR.pointSegDist(e.x, e.y, last.x, last.y, toX, toY);
        if (d < RC.ENGAGEMENT_RANGE - 1e-3) {
          return 'Leg crosses an enemy control range.';
        }
      }
    }
    return null;
  }

  // Reason the path's current endpoint is illegal for the action; null if OK.
  function endpointReason(u, pm) {
    const last = pm.waypoints[pm.waypoints.length - 1];
    const enemies = pathEnemyList(u);
    const inCR = enemies.some(e => Math.hypot(e.x - last.x, e.y - last.y) <= RC.ENGAGEMENT_RANGE + 1e-3);
    if (pm.kind === 'charge') {
      if (!inCR) return 'Charge must end within 1" of an enemy.';
    } else if (pm.kind === 'fallBack') {
      if (inCR) return 'Fall Back must end outside enemy control range.';
    } else {
      if (inCR) return 'Cannot end move in enemy control range.';
    }
    return null;
  }

  // ── Action execution helpers ──────────────────────────────────────
  function addWaypoint(x, y) {
    const a = activation();
    if (!a) return;
    const pm = state.combat.pendingMove;
    if (!pm) return;
    const u = a.unit;
    const reason = canExtendPathReason(u, pm, x, y);
    if (reason) {
      activationHint.textContent = reason;
      activationHint.classList.add('warn');
      syncActivationPanel();
      render();
      return;
    }
    const last = pm.waypoints[pm.waypoints.length - 1];
    pm.used += Math.hypot(x - last.x, y - last.y);
    pm.waypoints.push({ x, y });
    activationHint.classList.remove('warn');
    activationHint.textContent = '';
    syncActivationPanel();
    render();
  }

  function undoWaypoint() {
    const pm = state.combat.pendingMove;
    if (!pm || pm.waypoints.length <= 1) return;
    const last = pm.waypoints.pop();
    const prev = pm.waypoints[pm.waypoints.length - 1];
    pm.used = Math.max(0, pm.used - Math.hypot(last.x - prev.x, last.y - prev.y));
    activationHint.classList.remove('warn');
    activationHint.textContent = '';
    syncActivationPanel();
    render();
  }

  function cancelPath() {
    state.combat.pendingMove = null;
    activationHint.classList.remove('warn');
    activationHint.textContent = '';
    syncActivationPanel();
    render();
  }

  function commitPath() {
    const a = activation();
    if (!a) return;
    const pm = state.combat.pendingMove;
    if (!pm || pm.waypoints.length < 2) {
      activationHint.textContent = 'Tap on the board to set the destination first.';
      activationHint.classList.add('warn');
      return;
    }
    const u = a.unit;
    const reason = endpointReason(u, pm);
    if (reason) {
      activationHint.textContent = reason;
      activationHint.classList.add('warn');
      return;
    }
    pushUndo();
    const last = pm.waypoints[pm.waypoints.length - 1];
    u.x = last.x; u.y = last.y;
    let cost, label;
    if (pm.kind === 'reposition') { a.hasReposition = true; cost = RC.REPOSITION_AP; label = 'repositions'; }
    else if (pm.kind === 'dash')  { a.hasDashed = true;     cost = RC.DASH_AP;       label = 'dashes'; }
    else if (pm.kind === 'charge'){ a.hasCharged = true;    cost = RC.CHARGE_AP;     label = 'charges'; }
    else                          { a.hasFallenBack = true; cost = RC.FALL_BACK_AP;  label = 'falls back'; }
    a.ap -= cost;
    const legs = pm.waypoints.length - 1;
    a.history.push({ type: pm.kind, dist: pm.used, legs });
    log(`${u.letter} ${label} ${pm.used.toFixed(1)}"${legs > 1 ? ` (${legs} legs)` : ''}.`);
    state.combat.pendingMove = null;
    activationHint.classList.remove('warn');
    activationHint.textContent = '';
    syncActivationPanel();
    render();
  }

  // Teleport: from one T pad to another (Tomb World rule). Only available
  // from Turning Point 2 onwards. Costs the same as the Reposition / Dash /
  // Charge / Fall Back action it replaces.
  function teleportFromPad(kind, padTo) {
    const a = activation();
    if (!a) return;
    const u = a.unit;
    if (state.combat.turningPoint < 2) {
      activationHint.textContent = 'Teleporters are inert until Turning Point 2.';
      activationHint.classList.add('warn');
      return;
    }
    if (a.teleportedThisActivation) {
      activationHint.textContent = 'Already teleported this activation.';
      activationHint.classList.add('warn');
      return;
    }
    const padFrom = padAt(u.x, u.y);
    if (!padFrom) { activationHint.textContent = 'Must start on a teleport pad.'; activationHint.classList.add('warn'); return; }
    if (!padTo || padTo.pieceIndex === padFrom.pieceIndex) return;

    const cost = kind === 'fallBack' ? RC.FALL_BACK_AP : 1;
    if (a.ap < cost) { activationHint.textContent = 'Not enough AP.'; activationHint.classList.add('warn'); return; }

    pushUndo();
    u.x = padTo.x; u.y = padTo.y;
    a.ap -= cost;
    a.teleportedThisActivation = true;
    if (kind === 'reposition') a.hasReposition = true;
    if (kind === 'dash') a.hasDashed = true;
    if (kind === 'charge') a.hasCharged = true;
    if (kind === 'fallBack') a.hasFallenBack = true;
    a.history.push({ type: 'teleport', from: padFrom.pieceIndex, to: padTo.pieceIndex });
    log(`${u.letter} teleports across the pads.`);
    state.combat.pendingMove = null;
    syncActivationPanel();
    render();
  }

  function padAt(x, y) {
    const pads = mapDef.teleporters || [];
    return pads.find(p => Math.hypot(p.x - x, p.y - y) <= (p.r || 1.0)) || null;
  }
  function otherPads(currentPad) {
    return (mapDef.teleporters || []).filter(p => !currentPad || p.pieceIndex !== currentPad.pieceIndex);
  }

  // ── Hatchway / breach actions ──────────────────────────────────────
  // Each openable piece has a wall segment endpoint at its midpoint. The
  // operative must be within 1" of that midpoint to interact (control range).
  function nearestOpenable(u, kindFilter) {
    const list = mapDef.openable || [];
    let best = null, bestD = Infinity;
    for (const o of list) {
      if (kindFilter && o.kind !== kindFilter) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best || bestD > 1) return null;
    return best;
  }

  function performOpenHatchway() {
    const a = activation();
    if (!a) return;
    const u = a.unit;
    const target = nearestOpenable(u, 'hatchway');
    if (!target) { activationHint.textContent = 'No hatchway in reach.'; activationHint.classList.add('warn'); return; }
    if (a.ap < RC.OPEN_HATCH_AP) { activationHint.textContent = 'Not enough AP.'; activationHint.classList.add('warn'); return; }
    pushUndo();
    const open = state.combat.pieceState.open;
    const wasOpen = open.has(target.pieceIndex);
    if (wasOpen) open.delete(target.pieceIndex);
    else open.add(target.pieceIndex);
    a.ap -= RC.OPEN_HATCH_AP;
    a.history.push({ type: 'operateHatch', piece: target.pieceIndex, open: !wasOpen });
    log(`${u.letter} ${wasOpen ? 'closes' : 'opens'} hatchway ${target.label || ''}.`);
    syncActivationPanel();
    render();
  }

  function performBreach() {
    const a = activation();
    if (!a) return;
    const u = a.unit;
    const target = nearestOpenable(u, 'breach');
    if (!target) { activationHint.textContent = 'No breach point in reach.'; activationHint.classList.add('warn'); return; }
    const cost = KTR.breachAPCost(u);
    if (a.ap < cost) { activationHint.textContent = `Not enough AP for Breach (${cost}).`; activationHint.classList.add('warn'); return; }
    if (state.combat.pieceState.open.has(target.pieceIndex)) {
      activationHint.textContent = 'Already breached.'; activationHint.classList.add('warn'); return;
    }
    pushUndo();
    state.combat.pieceState.open.add(target.pieceIndex);
    a.ap -= cost;
    a.history.push({ type: 'breach', piece: target.pieceIndex });
    log(`${u.letter} breaches the wall ${target.label || ''} (${cost} AP).`);
    syncActivationPanel();
    render();
  }

  // ── Activation panel ────────────────────────────────────────────────
  function syncActivationPanel() {
    if (state.phase !== 'combat' || state.combat.over) {
      activationPanel.style.display = 'none';
      return;
    }
    activationPanel.style.display = '';
    const a = activation();
    if (!a) {
      // Pre-activation: prompt to pick a ready operative.
      const team = activeTeam();
      const ready = readyUnits(team);
      activationWho.textContent = `${teamName(team)} — pick an operative`;
      activationMeta.textContent = `${ready.length} ready · TP ${state.combat.turningPoint}`;
      activationOrders.style.display = 'none';
      activationActions.style.display = 'none';
      activationHint.classList.remove('warn');
      activationHint.textContent = ready.length
        ? 'Tap one of your ready operatives on the board or in the sidebar to activate them.'
        : 'No ready operatives. Press End Turning Point.';
      return;
    }
    const u = a.unit;
    activationWho.textContent = `${u.letter} · ${u._displayName}`;
    const orderTxt = a.order ? (a.order === 'engage' ? 'Engage' : 'Conceal') : '— no order';
    activationMeta.textContent = `AP ${a.ap}/${a.apMax} · ${orderTxt} · TP ${state.combat.turningPoint}`;
    if (!a.order) {
      activationOrders.style.display = '';
      activationActions.style.display = 'none';
      activationHint.classList.remove('warn');
      activationHint.textContent = '';
      return;
    }
    activationOrders.style.display = 'none';
    activationActions.style.display = '';
    renderActionGrid();
    const pm = state.combat.pendingMove;
    if (pm) {
      const remaining = Math.max(0, pm.maxInches - pm.used);
      const legs = pm.waypoints.length - 1;
      if (!activationHint.classList.contains('warn')) {
        activationHint.textContent = legs === 0
          ? `${pm.label}: tap on the board to set waypoints. Budget ${pm.maxInches.toFixed(1)}".`
          : `${pm.label}: ${pm.used.toFixed(1)}" used · ${remaining.toFixed(1)}" left · ${legs} leg${legs === 1 ? '' : 's'}. Add more waypoints to route around walls/CR; press Confirm to commit.`;
      }
    } else if (!a.history.length) {
      activationHint.classList.remove('warn');
      activationHint.textContent = 'Choose an action. Press Undo to revert any choice until you End Activation.';
    }
    undoBtn.disabled = a.undoStack.length === 0;
  }

  function renderActionGrid() {
    actionGrid.innerHTML = '';
    const a = activation();
    if (!a) return;
    const u = a.unit;
    const pm = state.combat.pendingMove;

    // While a move is being plotted, swap the grid for path controls so the
    // user is funnelled toward Confirm / Undo Waypoint / Cancel.
    if (pm) {
      const legs = pm.waypoints.length - 1;
      const endpointBlocked = legs > 0 ? endpointReason(u, pm) : null;
      const items = [
        { id: '_confirm',  name: 'Confirm Move', info: legs ? `Spend ${pm.used.toFixed(1)}" / ${pm.maxInches.toFixed(1)}"` : 'Add a waypoint first', cost: actionAPCost(pm.kind, u), reason: legs ? endpointBlocked : 'Tap on the board to set a waypoint.' },
        { id: '_undo_wp',  name: 'Undo Waypoint', info: legs ? `Remove last leg` : 'No legs yet', cost: '·', reason: legs ? null : 'No waypoints to undo.' },
        { id: '_cancel',   name: 'Cancel Move', info: 'Disarm this action', cost: '·', reason: null },
      ];
      for (const it of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'action-btn';
        if (it.id === '_confirm' && !it.reason) btn.classList.add('armed');
        btn.disabled = !!it.reason;
        btn.innerHTML = `
          <span class="ab-name">${it.name}</span>
          <span class="ab-cost"><strong>${it.cost === '·' ? '' : it.cost + ' AP · '}</strong>${escapeHtml(it.info)}</span>
          ${it.reason ? `<span class="ab-reason">${escapeHtml(it.reason)}</span>` : ''}
        `;
        btn.addEventListener('click', () => {
          if (it.id === '_confirm') commitPath();
          else if (it.id === '_undo_wp') undoWaypoint();
          else if (it.id === '_cancel') cancelPath();
        });
        actionGrid.appendChild(btn);
      }
      return;
    }

    const v = KTR.validate;
    const items = [
      { id: 'reposition', name: 'Reposition', cost: RC.REPOSITION_AP, info: `Move ${u.moveInches}"`, reason: v.reposition(u, a) },
      { id: 'dash',       name: 'Dash',       cost: RC.DASH_AP,        info: `Move ${RC.DASH_INCHES}"`,                  reason: v.dash(u, a) },
      { id: 'charge',     name: 'Charge',     cost: RC.CHARGE_AP,      info: `Move ${u.moveInches + RC.CHARGE_BONUS}", end in CR`, reason: v.charge(u, a, state.units) },
      { id: 'fallBack',   name: 'Fall Back',  cost: RC.FALL_BACK_AP,   info: `Move ${u.moveInches}"`,                    reason: v.fallBack(u, a, state.units) },
      { id: 'shoot',      name: 'Shoot',      cost: RC.SHOOT_AP,       info: 'Ranged attack',                             reason: v.shoot(u, a, state.units) },
      { id: 'fight',      name: 'Fight',      cost: RC.FIGHT_AP,       info: 'Melee attack',                              reason: v.fight(u, a, state.units) },
      { id: 'openHatch',  name: 'Operate Hatch', cost: RC.OPEN_HATCH_AP, info: 'Open / close', reason: nearestOpenable(u, 'hatchway') ? v.openHatchway(u, a) : 'No hatchway nearby.' },
      { id: 'breach',     name: 'Breach',     cost: KTR.breachAPCost(u), info: 'Open a breach point', reason: nearestOpenable(u, 'breach') ? v.breach(u, a) : 'No breach point nearby.' },
    ];
    for (const it of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-btn';
      const reason = it.reason;
      btn.disabled = !!reason;
      btn.innerHTML = `
        <span class="ab-name">${it.name}</span>
        <span class="ab-cost"><strong>${it.cost} AP</strong> · ${escapeHtml(it.info)}</span>
        ${reason ? `<span class="ab-reason">${escapeHtml(reason)}</span>` : ''}
      `;
      btn.addEventListener('click', () => onActionClick(it.id));
      actionGrid.appendChild(btn);
    }
  }

  function actionAPCost(kind, unit) {
    if (kind === 'reposition') return RC.REPOSITION_AP;
    if (kind === 'dash') return RC.DASH_AP;
    if (kind === 'charge') return RC.CHARGE_AP;
    if (kind === 'fallBack') return RC.FALL_BACK_AP;
    return 1;
  }

  function onActionClick(id) {
    const a = activation();
    if (!a) return;
    activationHint.classList.remove('warn');
    activationHint.textContent = '';
    if (id === 'reposition' || id === 'dash' || id === 'charge' || id === 'fallBack') {
      const u = a.unit;
      const max =
        id === 'reposition' ? u.moveInches :
        id === 'dash' ? RC.DASH_INCHES :
        id === 'charge' ? u.moveInches + RC.CHARGE_BONUS :
        u.moveInches;
      const labels = { reposition: 'Reposition', dash: 'Dash', charge: 'Charge', fallBack: 'Fall Back' };
      state.combat.pendingMove = {
        actionId: id, kind: id, label: labels[id], maxInches: max,
        // The unit's current position is the path's first (locked) waypoint.
        // Each subsequent click adds a leg.
        waypoints: [{ x: u.x, y: u.y }],
        used: 0,
      };
      // If on a teleport pad and TP >= 2, also surface a teleport prompt so
      // the player can choose to swap pads instead of pathing.
      const pad = padAt(u.x, u.y);
      if (pad && state.combat.turningPoint >= 2) {
        const others = otherPads(pad);
        if (others.length) showTeleportPicker(others, id);
      }
      syncActivationPanel();
      render();
      return;
    }
    if (id === 'shoot') { openShootPrep(); return; }
    if (id === 'fight') { openFightPrep(); return; }
    if (id === 'openHatch') { performOpenHatchway(); return; }
    if (id === 'breach') { performBreach(); return; }
  }

  // ── Target picker (transient overlay above the board) ────────────────
  function clearTargetPicker() {
    targetPicker.style.display = 'none';
    targetPicker.innerHTML = '';
  }
  function showTargetPickerAt(items, opts) {
    clearTargetPicker();
    if (!items.length) return;
    const rect = canvas.getBoundingClientRect();
    targetPicker.style.left = (rect.left + 12) + 'px';
    targetPicker.style.top = (rect.top + 12) + 'px';
    targetPicker.style.display = '';
    if (opts && opts.title) {
      const h = document.createElement('div');
      h.style.fontFamily = 'var(--section-font)';
      h.style.fontSize = '10px';
      h.style.letterSpacing = '0.18em';
      h.style.textTransform = 'uppercase';
      h.style.color = 'var(--text-muted)';
      h.style.padding = '4px 8px';
      h.textContent = opts.title;
      targetPicker.appendChild(h);
    }
    items.forEach(it => {
      const row = document.createElement('div');
      row.className = 'kt-target-row';
      row.innerHTML = `
        <div class="kt-target-letter" style="background:${it.color || '#3a302a'}">${escapeHtml(it.letter || '?')}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;">${escapeHtml(it.name)}</div>
          <div style="font-size:10px;color:var(--text-muted)">${escapeHtml(it.meta || '')}</div>
        </div>
      `;
      row.addEventListener('click', () => { it.onPick(); });
      targetPicker.appendChild(row);
    });
    const cancel = document.createElement('div');
    cancel.className = 'kt-target-row';
    cancel.style.borderTop = '1px solid var(--border-mid)';
    cancel.innerHTML = `<div style="text-align:center;width:100%;color:var(--text-muted);font-size:10px;">Cancel</div>`;
    cancel.addEventListener('click', clearTargetPicker);
    targetPicker.appendChild(cancel);
  }

  function showTeleportPicker(pads, actionId) {
    const items = pads.map((p, i) => ({
      letter: 'T' + (i + 1),
      name: 'Teleport pad',
      meta: `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`,
      color: '#7a9c3e',
      onPick: () => { clearTargetPicker(); teleportFromPad(actionId, p); },
    }));
    showTargetPickerAt(items, { title: 'Teleport to' });
  }

  // ── Shoot flow ──────────────────────────────────────────────────────
  function shootCandidates(attacker) {
    const out = [];
    for (const o of state.units) {
      if (!o.alive || !o.deployed || o.team === attacker.team) continue;
      const env = KTR.shootEnv(mapDef, state.combat.pieceState.open, attacker, o);
      if (!env.visible) continue;
      // Conceal target with cover cannot be selected (unless attacker within 2" of cover).
      if (o.order === 'conceal' && env.inCover) continue;
      out.push({ target: o, env });
    }
    return out;
  }

  function openShootPrep() {
    const a = activation();
    if (!a) return;
    const u = a.unit;
    const cands = shootCandidates(u);
    if (!cands.length) {
      activationHint.textContent = 'No valid targets in line of sight.';
      activationHint.classList.add('warn');
      return;
    }
    const items = cands.map(c => {
      const ti = TEAM_INFO[c.target.team];
      const dist = Math.hypot(c.target.x - u.x, c.target.y - u.y).toFixed(1);
      const flags = [];
      if (c.env.inCover) flags.push('Light cover');
      if (c.target.order === 'conceal') flags.push('Conceal');
      else if (c.target.order === 'engage') flags.push('Engage');
      return {
        letter: c.target.letter,
        name: c.target._displayName,
        meta: `${dist}" · HP ${c.target.hp}/${c.target.maxHp}${flags.length ? ' · ' + flags.join(', ') : ''}`,
        color: ti.color,
        onPick: () => { clearTargetPicker(); openShootModal(u, c.target, c.env); },
      };
    });
    showTargetPickerAt(items, { title: 'Shoot — pick target' });
  }

  function openShootModal(attacker, target, env) {
    const ranged = (attacker.weapons || []).filter(w => !w.is_melee);
    if (!ranged.length) return;
    state.combat.shoot = {
      attacker, target, env,
      weapon: ranged[0],
      step: 'pickWeapon',
      atk: null, def: null,
      atkDicePool: [], // dice categorised
      defDicePool: [],
      atkRemaining: null, defRemaining: null,
      damage: 0,
      done: false,
    };
    shootModal.style.display = 'flex';
    renderShootModal();
  }

  function closeShootModal() {
    shootModal.style.display = 'none';
    shootBody.innerHTML = '';
    state.combat.shoot = null;
  }

  function renderShootModal() {
    const s = state.combat.shoot;
    if (!s) return;
    const w = s.weapon;
    const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
    const inCover = s.env.inCover;
    const ti = TEAM_INFO;
    const dice = KTR.defenceDiceCount(parsed, inCover);
    const rangeStr = KTR.rangeFromInches(w);
    let html = `
      <div class="kt-side-row">
        <div class="kt-side">
          <h3>Shooter</h3>
          <div class="kt-side-meta">
            <strong>${s.attacker.letter} · ${escapeHtml(s.attacker._displayName)}</strong><br>
            Atk ${w.atk} · Hit ${w.hit}+ · Dmg ${w.normal_dmg}/${w.crit_dmg}<br>
            ${escapeHtml(w.name)}${(w.rules && w.rules.length) ? ' · ' + escapeHtml(w.rules.join(' · ')) : ''}<br>
            Range ${rangeStr}
          </div>
        </div>
        <div class="kt-side">
          <h3>Target</h3>
          <div class="kt-side-meta">
            <strong>${s.target.letter} · ${escapeHtml(s.target._displayName)}</strong><br>
            Save ${s.target.save}+ · HP ${s.target.hp}/${s.target.maxHp}<br>
            ${s.env.inCover ? 'Light cover (1 auto-save)' : 'No cover'} · ${s.target.order === 'conceal' ? 'Conceal' : 'Engage'}<br>
            Defence dice: ${dice.dice}D6
          </div>
        </div>
      </div>
    `;

    // Weapon picker (only if multiple ranged weapons exist)
    const ranged = (s.attacker.weapons || []).filter(x => !x.is_melee);
    if (ranged.length > 1) {
      html += `<span class="kt-step-tag">Step 1 · Weapon</span><div class="kt-weapon-pick" id="kt-weapon-pick">`;
      for (let i = 0; i < ranged.length; i++) {
        const r = ranged[i];
        html += `<div class="kt-weapon-row${r === s.weapon ? ' selected' : ''}" data-i="${i}">
          <span class="kt-w-name">${escapeHtml(r.name)}</span>
          <span class="kt-w-stats">A${r.atk} · ${r.hit}+ · ${r.normal_dmg}/${r.crit_dmg}${r.rules && r.rules.length ? ' · ' + escapeHtml(r.rules.join(', ')) : ''}</span>
        </div>`;
      }
      html += `</div>`;
    }

    // Step rendering
    if (s.step === 'pickWeapon') {
      html += `<div class="kt-modal-footer"><button class="btn-fire" id="kt-roll-attack">Roll Attack (${w.atk}D6)</button></div>`;
    } else {
      html += `<div class="kt-resolve-step"><span class="kt-step-tag">Step · Attack roll</span>`;
      html += diceRowHTML(s.atk, 'atk') + `</div>`;
      if (s.step === 'rolledAttack') {
        html += `<div class="kt-modal-footer"><button class="btn-fire" id="kt-roll-defence">Roll Defence (${dice.dice}D6${dice.autoNormals ? ' + 1 cover save' : ''})</button></div>`;
      } else {
        html += `<div class="kt-resolve-step"><span class="kt-step-tag">Step · Defence roll</span>`;
        html += diceRowHTML(s.def, 'def') + `</div>`;
        if (s.step === 'rolledDefence') {
          html += `<div class="kt-modal-footer">
            <button class="btn-ghost" id="kt-allocate-auto">Allocate optimally</button>
            <button class="btn-fire" id="kt-allocate-manual">Allocate manually</button>
          </div>`;
        } else if (s.step === 'allocate') {
          html += `<div class="kt-resolved" id="kt-alloc-help">Click a defence success then a matching attack success to block. Crit blocks any; normal blocks normal (or two normals block one crit).</div>`;
          html += `<div class="kt-modal-footer">
            <button class="btn-ghost" id="kt-allocate-auto">Auto-resolve remainder</button>
            <button class="btn-fire" id="kt-resolve">Resolve damage</button>
          </div>`;
        } else if (s.step === 'resolved') {
          html += `<div class="kt-resolved">
            ${s.target.letter} takes <strong>${s.damage}</strong> damage (${s.atkRemaining.normals} normal × ${w.normal_dmg} + ${s.atkRemaining.criticals} crit × ${w.crit_dmg}).
            ${s.killed ? '<br><strong>Incapacitated.</strong>' : `<br>HP now ${Math.max(0, s.target.hp)} / ${s.target.maxHp}.`}
          </div>
          <div class="kt-modal-footer">
            <button class="btn-fire" id="kt-shoot-done">Done</button>
          </div>`;
        }
      }
    }

    shootBody.innerHTML = html;

    // Wire up
    const wp = shootBody.querySelector('#kt-weapon-pick');
    if (wp) {
      wp.querySelectorAll('.kt-weapon-row').forEach(row => {
        row.addEventListener('click', () => {
          const i = +row.dataset.i;
          s.weapon = ranged[i];
          renderShootModal();
        });
      });
    }
    const ra = shootBody.querySelector('#kt-roll-attack');
    if (ra) ra.addEventListener('click', rollShootAttack);
    const rd = shootBody.querySelector('#kt-roll-defence');
    if (rd) rd.addEventListener('click', rollShootDefence);
    const aa = shootBody.querySelector('#kt-allocate-auto');
    if (aa) aa.addEventListener('click', () => { allocateShootSavesOptimally(); s.step = 'resolved'; renderShootModal(); });
    const am = shootBody.querySelector('#kt-allocate-manual');
    if (am) am.addEventListener('click', () => { s.step = 'allocate'; renderShootModal(); attachManualAllocate(); });
    const rs = shootBody.querySelector('#kt-resolve');
    if (rs) rs.addEventListener('click', () => { applyShootResolution(); });
    const dn = shootBody.querySelector('#kt-shoot-done');
    if (dn) dn.addEventListener('click', commitShoot);

    if (s.step === 'allocate') attachManualAllocate();
  }

  function diceRowHTML(roll, side) {
    if (!roll) return '';
    const cells = [];
    // Pre-retained successes (autoNormals / cover save) shown first.
    const auto = roll.autoNormals || 0;
    for (let i = 0; i < auto; i++) cells.push(`<div class="kt-dice normal" data-tag="${side}-auto-${i}">A<div class="kt-dice-tag">cover</div></div>`);
    for (let i = 0; i < (roll.rolls || []).length; i++) {
      const v = roll.rolls[i];
      let cls = 'fail';
      let cat = 'fail';
      if (roll.crits && roll.crits.includes(i)) { cls = 'crit'; cat = 'crit'; }
      else if (roll.normals && roll.normals.includes(i)) { cls = 'normal'; cat = 'normal'; }
      cells.push(`<div class="kt-dice ${cls}" data-tag="${side}-${i}" data-cat="${cat}" data-idx="${i}">${v}</div>`);
    }
    return `<div class="kt-dice-row">${cells.join('')}</div>`;
  }

  function rollShootAttack() {
    const s = state.combat.shoot;
    if (!s) return;
    const w = s.weapon;
    const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
    let lethal = KTR.ruleByName(parsed, 'Lethal');
    // Close Quarters (Tomb World killzone): weapons with Blast / Torrent /
    // distance-based Devastating also gain Lethal 5+. We treat any weapon
    // with Blast, Torrent, or Devastating as qualifying.
    const cq = KTR.hasRule(parsed, 'Blast') || KTR.hasRule(parsed, 'Torrent') || KTR.hasRule(parsed, 'Devastating');
    if (cq && (!lethal || lethal.value > 5)) lethal = { name: 'Lethal', value: 5, raw: 'Lethal 5+ (Close Quarters)' };
    const critAt = lethal ? lethal.value : 6;
    if (cq) log(`Close Quarters: ${w.name} gains Lethal 5+.`);
    let bs = w.hit;
    // Wounded/injured: +1 to Hit (worsened) -- we apply if attacker is injured.
    if (KTR.isInjured(s.attacker)) bs = Math.min(6, bs + 1);
    const atkDice = w.atk;

    const out = KTR.rollAttack(atkDice, bs, critAt, 0, 0);
    // Convert flat counts into per-roll category indices for the UI.
    const rolls = out.rolls;
    const crits = [], normals = [], fails = [];
    for (let i = 0; i < rolls.length; i++) {
      const v = rolls[i];
      if (v >= critAt) crits.push(i);
      else if (v >= bs) normals.push(i);
      else fails.push(i);
    }
    let nN = normals.length, nC = crits.length, nF = fails.length;
    // Severe / Rending / Punishing fixups.
    let didFix = '';
    if (KTR.hasRule(parsed, 'Severe') && nC === 0 && nN > 0) {
      const idx = normals.pop(); crits.push(idx); nN--; nC++; didFix += ' Severe';
    }
    if (KTR.hasRule(parsed, 'Rending') && nC > 0 && nN > 0) {
      const idx = normals.pop(); crits.push(idx); nN--; nC++; didFix += ' Rending';
    }
    if (KTR.hasRule(parsed, 'Punishing') && nC > 0 && nF > 0) {
      const idx = fails.pop(); normals.push(idx); nF--; nN++; didFix += ' Punishing';
    }
    s.atk = { rolls, crits, normals, fails, autoNormals: 0,
      counts: { n: nN, c: nC, f: nF },
      bs, critAt,
    };
    s.step = 'rolledAttack';
    log(`${s.attacker.letter} fires ${atkDice}D6 at ${s.target.letter}: ${nC} crit · ${nN} normal · ${nF} fail${didFix ? ' (' + didFix.trim() + ')' : ''}.`);
    renderShootModal();
  }

  function rollShootDefence() {
    const s = state.combat.shoot;
    if (!s) return;
    const w = s.weapon;
    const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
    const inCover = s.env.inCover;
    const dice = KTR.defenceDiceCount(parsed, inCover);
    const save = KTR.effectiveSave(s.target, parsed);
    const out = KTR.rollDefence(dice.dice, save, 0);
    const rolls = out.rolls;
    const crits = [], normals = [], fails = [];
    for (let i = 0; i < rolls.length; i++) {
      const v = rolls[i];
      if (v === 6) crits.push(i);
      else if (v >= save) normals.push(i);
      else fails.push(i);
    }
    s.def = {
      rolls, crits, normals, fails,
      autoNormals: dice.autoNormals,
      counts: { n: normals.length + dice.autoNormals, c: crits.length, f: fails.length },
      save,
    };
    s.step = 'rolledDefence';
    log(`${s.target.letter} rolls defence (${dice.dice}D6 + ${dice.autoNormals} cover): ${crits.length} crit · ${normals.length + dice.autoNormals} normal · ${fails.length} fail.`);
    renderShootModal();
  }

  function allocateShootSavesOptimally() {
    const s = state.combat.shoot;
    if (!s) return;
    const w = s.weapon;
    const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
    const brutal = KTR.hasRule(parsed, 'Brutal');
    const r = KTR.allocateSavesOptimally(
      s.atk.counts.n, s.atk.counts.c,
      s.def.counts.n, s.def.counts.c,
      w.normal_dmg, w.crit_dmg, brutal
    );
    s.atkRemaining = { normals: r.remN, criticals: r.remC };
    s.defRemaining = { normals: 0, criticals: 0 };
    s.damage = r.remN * w.normal_dmg + r.remC * w.crit_dmg;
    // Devastating: each crit retained inflicts crit dmg ignoring saves.
    const dev = KTR.ruleByName(parsed, 'Devastating');
    if (dev && s.atk.counts.c > 0) {
      // Already counted via remC; KT3 Devastating applies even before saves.
      s.damage = r.remN * w.normal_dmg + s.atk.counts.c * Math.max(w.crit_dmg, dev.value);
      s.atkRemaining.criticals = s.atk.counts.c;
    }
  }

  function attachManualAllocate() {
    const s = state.combat.shoot;
    if (!s) return;
    s.manual = s.manual || {
      atkConsumed: new Set(), // 'auto-i' or 'i'
      defConsumed: new Set(),
      autoSavedRemaining: s.def.autoNormals,
    };
    // Highlight selectable defence dice
    shootBody.querySelectorAll('.kt-dice[data-tag^="def-"]').forEach(d => {
      const cat = d.dataset.cat;
      if (!cat || cat === 'fail') return;
      d.classList.add('selectable');
      d.addEventListener('click', () => onDefenceDieClick(d));
    });
  }

  function onDefenceDieClick(d) {
    const s = state.combat.shoot;
    if (!s || s.step !== 'allocate') return;
    const cat = d.dataset.cat;
    if (cat === 'fail') return;
    // Toggle armed
    shootBody.querySelectorAll('.kt-dice[data-tag^="def-"]').forEach(o => o.classList.remove('armed'));
    d.classList.add('armed');
    s.manual.armedDefence = d;
    s.manual.armedDefenceCat = cat;
    // Now wait for attack die click
    shootBody.querySelectorAll('.kt-dice[data-tag^="atk-"]').forEach(a => {
      const acat = a.dataset.cat;
      if (acat === 'fail') return;
      a.classList.add('selectable');
      a.onclick = () => attemptManualBlock(a, d);
    });
  }

  function attemptManualBlock(atkEl, defEl) {
    const s = state.combat.shoot;
    if (!s) return;
    const acat = atkEl.dataset.cat;
    const dcat = defEl.dataset.cat;
    if (s.manual.atkConsumed.has(atkEl.dataset.tag) || s.manual.defConsumed.has(defEl.dataset.tag)) return;
    // Block rules:
    //  - Crit blocks crit or normal
    //  - Normal blocks normal
    //  - Two normals can block a crit (must select both; we'll prompt)
    if (dcat === 'crit') {
      if (acat === 'crit' || acat === 'normal') {
        atkEl.classList.add('spent'); defEl.classList.add('spent');
        s.manual.atkConsumed.add(atkEl.dataset.tag);
        s.manual.defConsumed.add(defEl.dataset.tag);
        clearArmedState();
      }
    } else if (dcat === 'normal') {
      if (acat === 'normal') {
        atkEl.classList.add('spent'); defEl.classList.add('spent');
        s.manual.atkConsumed.add(atkEl.dataset.tag);
        s.manual.defConsumed.add(defEl.dataset.tag);
        clearArmedState();
      }
    }
  }
  function clearArmedState() {
    shootBody.querySelectorAll('.kt-dice').forEach(d => { d.classList.remove('armed'); d.onclick = null; });
    attachManualAllocate();
  }

  function applyShootResolution() {
    const s = state.combat.shoot;
    if (!s) return;
    if (!s.atkRemaining) {
      // Manual mode: count remaining atk dice
      let remN = 0, remC = 0;
      const atkDice = shootBody.querySelectorAll('.kt-dice[data-tag^="atk-"]');
      atkDice.forEach(d => {
        if (d.classList.contains('spent') || d.classList.contains('fail')) return;
        if (d.dataset.cat === 'normal') remN++;
        else if (d.dataset.cat === 'crit') remC++;
      });
      const w = s.weapon;
      s.atkRemaining = { normals: remN, criticals: remC };
      s.damage = remN * w.normal_dmg + remC * w.crit_dmg;
    }
    s.step = 'resolved';
    renderShootModal();
  }

  function commitShoot() {
    const s = state.combat.shoot;
    if (!s) return;
    pushUndo();
    const a = activation();
    const w = s.weapon;
    a.ap -= RC.SHOOT_AP;
    a.hasShot = true;
    a.history.push({ type: 'shoot', target: s.target.letter, weapon: w.name, dmg: s.damage });
    s.target.hp = Math.max(0, s.target.hp - s.damage);
    if (s.target.hp <= 0) {
      s.target.alive = false;
      s.target.unitState = 'incapacitated';
      log(`${s.target.letter} (${s.target._displayName}) is incapacitated by ${s.attacker.letter} (${s.damage} dmg).`, 'kill');
      s.killed = true;
      registerKill(s.attacker.team);
    } else {
      log(`${s.attacker.letter} hits ${s.target.letter} for ${s.damage}.`, 'hit');
    }
    closeShootModal();
    if (checkVictory()) return;
    syncActivationPanel();
    render();
  }

  // ── Fight flow ──────────────────────────────────────────────────────
  function fightCandidates(attacker) {
    const out = [];
    for (const o of state.units) {
      if (!o.alive || !o.deployed || o.team === attacker.team) continue;
      if (Math.hypot(o.x - attacker.x, o.y - attacker.y) <= RC.ENGAGEMENT_RANGE) out.push(o);
    }
    return out;
  }

  function openFightPrep() {
    const a = activation();
    if (!a) return;
    const u = a.unit;
    const cands = fightCandidates(u);
    if (!cands.length) {
      activationHint.textContent = 'No enemy in control range.';
      activationHint.classList.add('warn');
      return;
    }
    if (cands.length === 1) { openFightModal(u, cands[0]); return; }
    const items = cands.map(t => {
      const ti = TEAM_INFO[t.team];
      return {
        letter: t.letter, name: t._displayName,
        meta: `HP ${t.hp}/${t.maxHp}`,
        color: ti.color,
        onPick: () => { clearTargetPicker(); openFightModal(u, t); },
      };
    });
    showTargetPickerAt(items, { title: 'Fight — pick target' });
  }

  function openFightModal(attacker, target) {
    const meleeA = (attacker.weapons || []).filter(w => w.is_melee);
    const meleeT = (target.weapons || []).filter(w => w.is_melee);
    if (!meleeA.length || !meleeT.length) return;
    state.combat.fight = {
      attacker, target,
      weaponA: meleeA[0],
      weaponT: meleeT[0],
      step: 'pickWeapon',
      atkA: null, atkT: null,
      next: 'A',         // whose turn to spend a die (attacker first)
      damageA: 0, damageT: 0,
      done: false,
    };
    fightModal.style.display = 'flex';
    renderFightModal();
  }
  function closeFightModal() {
    fightModal.style.display = 'none';
    fightBody.innerHTML = '';
    state.combat.fight = null;
  }

  function renderFightModal() {
    const f = state.combat.fight;
    if (!f) return;
    const wA = f.weaponA, wT = f.weaponT;
    let html = `
      <div class="kt-side-row">
        <div class="kt-side">
          <h3>Attacker · ${f.attacker.letter}</h3>
          <div class="kt-side-meta">
            <strong>${escapeHtml(f.attacker._displayName)}</strong><br>
            HP ${f.attacker.hp}/${f.attacker.maxHp}<br>
            ${escapeHtml(wA.name)} · A${wA.atk} · ${wA.hit}+ · ${wA.normal_dmg}/${wA.crit_dmg}
          </div>
        </div>
        <div class="kt-side">
          <h3>Defender · ${f.target.letter}</h3>
          <div class="kt-side-meta">
            <strong>${escapeHtml(f.target._displayName)}</strong><br>
            HP ${f.target.hp}/${f.target.maxHp}<br>
            ${escapeHtml(wT.name)} · A${wT.atk} · ${wT.hit}+ · ${wT.normal_dmg}/${wT.crit_dmg}
          </div>
        </div>
      </div>
    `;

    // Weapon pickers
    const meleeA = (f.attacker.weapons || []).filter(w => w.is_melee);
    const meleeT = (f.target.weapons || []).filter(w => w.is_melee);
    if (meleeA.length > 1 || meleeT.length > 1) {
      html += `<span class="kt-step-tag">Step 1 · Weapons</span>`;
      if (meleeA.length > 1) {
        html += `<div class="kt-weapon-pick" id="kt-weapon-pick-A">`;
        meleeA.forEach((r, i) => {
          html += `<div class="kt-weapon-row${r === f.weaponA ? ' selected' : ''}" data-i="${i}">
            <span class="kt-w-name">A · ${escapeHtml(r.name)}</span>
            <span class="kt-w-stats">A${r.atk} · ${r.hit}+ · ${r.normal_dmg}/${r.crit_dmg}</span>
          </div>`;
        });
        html += `</div>`;
      }
      if (meleeT.length > 1) {
        html += `<div class="kt-weapon-pick" id="kt-weapon-pick-T">`;
        meleeT.forEach((r, i) => {
          html += `<div class="kt-weapon-row${r === f.weaponT ? ' selected' : ''}" data-i="${i}">
            <span class="kt-w-name">D · ${escapeHtml(r.name)}</span>
            <span class="kt-w-stats">A${r.atk} · ${r.hit}+ · ${r.normal_dmg}/${r.crit_dmg}</span>
          </div>`;
        });
        html += `</div>`;
      }
    }

    if (f.step === 'pickWeapon') {
      html += `<div class="kt-modal-footer"><button class="btn-fire" id="kt-fight-roll">Roll Combat Dice</button></div>`;
    } else {
      html += `<div class="kt-resolve-step"><span class="kt-step-tag">Attacker dice</span>${diceRowHTML(f.atkA, 'fa')}</div>`;
      html += `<div class="kt-resolve-step"><span class="kt-step-tag">Defender dice</span>${diceRowHTML(f.atkT, 'fb')}</div>`;
      if (f.step === 'rolled' || f.step === 'resolving') {
        html += `<div class="kt-resolved" id="kt-fight-prompt">${
          fightPrompt(f)
        }</div>`;
        html += `<div class="kt-modal-footer">
          <button class="btn-ghost" id="kt-fight-auto">Auto-resolve</button>
          <button class="btn-fire" id="kt-fight-end" ${fightDone(f) ? '' : 'disabled'}>Apply damage</button>
        </div>`;
      }
    }

    fightBody.innerHTML = html;

    const wpA = fightBody.querySelector('#kt-weapon-pick-A');
    if (wpA) wpA.querySelectorAll('.kt-weapon-row').forEach(row => row.addEventListener('click', () => {
      f.weaponA = meleeA[+row.dataset.i]; renderFightModal();
    }));
    const wpT = fightBody.querySelector('#kt-weapon-pick-T');
    if (wpT) wpT.querySelectorAll('.kt-weapon-row').forEach(row => row.addEventListener('click', () => {
      f.weaponT = meleeT[+row.dataset.i]; renderFightModal();
    }));
    const rb = fightBody.querySelector('#kt-fight-roll');
    if (rb) rb.addEventListener('click', rollFight);
    const auto = fightBody.querySelector('#kt-fight-auto');
    if (auto) auto.addEventListener('click', () => { autoResolveFight(); renderFightModal(); });
    const ee = fightBody.querySelector('#kt-fight-end');
    if (ee) ee.addEventListener('click', commitFight);
    if (f.step === 'rolled' || f.step === 'resolving') attachFightDiceHandlers();
  }

  function fightPrompt(f) {
    const next = f.next;
    if (fightDone(f)) {
      return `Combat resolved. <strong>${f.attacker.letter}</strong> took ${f.damageA} dmg. <strong>${f.target.letter}</strong> took ${f.damageT} dmg.`;
    }
    const who = next === 'A' ? f.attacker.letter + ' (attacker)' : f.target.letter + ' (defender)';
    const remA = remainingFightDice(f, 'A');
    const remT = remainingFightDice(f, 'T');
    if (next === 'A' && remA === 0) return `${f.attacker.letter} has no dice left. ${f.target.letter} resolves remaining strikes.`;
    if (next === 'T' && remT === 0) return `${f.target.letter} has no dice left. ${f.attacker.letter} resolves remaining strikes.`;
    return `${who} — pick a die: <strong>Strike</strong> to deal damage, <strong>Parry</strong> to block one of the opponent's successes.`;
  }

  function remainingFightDice(f, who) {
    const set = who === 'A' ? f.atkA : f.atkT;
    if (!set) return 0;
    return set.crits.length + set.normals.length - (set.spent ? set.spent.size : 0);
  }
  function fightDone(f) {
    if (!f.atkA || !f.atkT) return false;
    return remainingFightDice(f, 'A') === 0 && remainingFightDice(f, 'T') === 0;
  }

  function rollFight() {
    const f = state.combat.fight;
    if (!f) return;
    function rollSide(weapon, opName) {
      const parsed = weapon._parsedRules || (weapon._parsedRules = KTR.parseWeaponRules(weapon.rules));
      const lethal = KTR.ruleByName(parsed, 'Lethal');
      const critAt = lethal ? lethal.value : 6;
      const out = KTR.rollAttack(weapon.atk, weapon.hit, critAt, 0, 0);
      const rolls = out.rolls;
      const crits = [], normals = [], fails = [];
      for (let i = 0; i < rolls.length; i++) {
        const v = rolls[i];
        if (v >= critAt) crits.push(i);
        else if (v >= weapon.hit) normals.push(i);
        else fails.push(i);
      }
      // Severe / Rending / Punishing
      if (KTR.hasRule(parsed, 'Severe') && crits.length === 0 && normals.length > 0) {
        const idx = normals.pop(); crits.push(idx);
      }
      if (KTR.hasRule(parsed, 'Rending') && crits.length > 0 && normals.length > 0) {
        const idx = normals.pop(); crits.push(idx);
      }
      if (KTR.hasRule(parsed, 'Punishing') && crits.length > 0 && fails.length > 0) {
        const idx = fails.pop(); normals.push(idx);
      }
      log(`${opName} rolls ${weapon.atk}D6 (${weapon.name}): ${crits.length} crit · ${normals.length} normal · ${fails.length} fail.`);
      return { rolls, crits, normals, fails, autoNormals: 0, spent: new Set(), parsed, weapon };
    }
    f.atkA = rollSide(f.weaponA, f.attacker.letter);
    f.atkT = rollSide(f.weaponT, f.target.letter);
    f.next = 'A'; // attacker resolves first
    f.step = 'rolled';
    renderFightModal();
  }

  function attachFightDiceHandlers() {
    const f = state.combat.fight;
    if (!f) return;
    function wire(side, dataPrefix, set) {
      fightBody.querySelectorAll(`.kt-dice[data-tag^="${dataPrefix}-"]`).forEach(d => {
        const cat = d.dataset.cat;
        const idx = +d.dataset.idx;
        if (!cat || cat === 'fail') return;
        if (set.spent.has(idx)) { d.classList.add('spent'); return; }
        if (f.next !== side) return;
        d.classList.add('selectable');
        d.onclick = () => onFightDieClick(side, idx, d, cat);
      });
    }
    wire('A', 'fa', f.atkA);
    wire('T', 'fb', f.atkT);
  }

  function onFightDieClick(side, idx, dEl, cat) {
    const f = state.combat.fight;
    if (!f) return;
    if (f.next !== side) return;
    // Show a tiny confirm: strike vs parry
    const choice = strikeOrParryPrompt(side, cat);
    if (!choice) return;
    const set = side === 'A' ? f.atkA : f.atkT;
    set.spent.add(idx);
    if (choice === 'strike') {
      const dmg = cat === 'crit' ? set.weapon.crit_dmg : set.weapon.normal_dmg;
      if (side === 'A') f.damageT += dmg;
      else f.damageA += dmg;
      log(`${side === 'A' ? f.attacker.letter : f.target.letter} strikes for ${dmg}.`);
    } else {
      // Parry: discard one of the opponent's unresolved dice (highest first).
      const oppSet = side === 'A' ? f.atkT : f.atkA;
      // Crit parry can drop crit; normal parry can drop normal
      let target = null;
      if (cat === 'crit') {
        for (const i of oppSet.crits) if (!oppSet.spent.has(i)) { target = i; break; }
        if (target == null) for (const i of oppSet.normals) if (!oppSet.spent.has(i)) { target = i; break; }
      } else {
        for (const i of oppSet.normals) if (!oppSet.spent.has(i)) { target = i; break; }
      }
      if (target != null) {
        oppSet.spent.add(target);
        log(`${side === 'A' ? f.attacker.letter : f.target.letter} parries.`);
      } else {
        // No valid parry target: revert spent on this side
        set.spent.delete(idx);
        return;
      }
    }
    // Switch sides; if other has no dice, stay.
    const otherSide = side === 'A' ? 'T' : 'A';
    if (remainingFightDice(f, otherSide) > 0) f.next = otherSide;
    else f.next = side; // continue on same side
    renderFightModal();
  }

  function strikeOrParryPrompt(side, cat) {
    // Reuse confirm() for simplicity (good for desktop + mobile).
    const useStrike = window.confirm(
      `${side === 'A' ? 'Attacker' : 'Defender'} ${cat === 'crit' ? 'critical' : 'normal'} success — OK = Strike, Cancel = Parry`
    );
    return useStrike ? 'strike' : 'parry';
  }

  function autoResolveFight() {
    const f = state.combat.fight;
    if (!f) return;
    // Greedy: each side strikes if it has dice; alternates. If side has only
    // dice that can't kill, prefer parry first.
    while (!fightDone(f)) {
      const side = f.next;
      const set = side === 'A' ? f.atkA : f.atkT;
      const oppSet = side === 'A' ? f.atkT : f.atkA;
      // pick highest unresolved on this side
      let useIdx = null, useCat = null;
      for (const i of set.crits) if (!set.spent.has(i)) { useIdx = i; useCat = 'crit'; break; }
      if (useIdx == null) for (const i of set.normals) if (!set.spent.has(i)) { useIdx = i; useCat = 'normal'; break; }
      if (useIdx == null) {
        // no dice this side
        const otherSide = side === 'A' ? 'T' : 'A';
        if (remainingFightDice(f, otherSide) === 0) break;
        f.next = otherSide; continue;
      }
      // Decide strike vs parry:
      //   Parry an opponent crit if available; else strike.
      let oppHasCrit = false;
      for (const i of oppSet.crits) if (!oppSet.spent.has(i)) { oppHasCrit = true; break; }
      let action = 'strike';
      if (useCat === 'crit' && oppHasCrit) action = 'parry';
      // mark spent
      set.spent.add(useIdx);
      if (action === 'strike') {
        const dmg = useCat === 'crit' ? set.weapon.crit_dmg : set.weapon.normal_dmg;
        if (side === 'A') f.damageT += dmg;
        else f.damageA += dmg;
      } else {
        // parry highest opponent
        let parryIdx = null;
        for (const i of oppSet.crits) if (!oppSet.spent.has(i)) { parryIdx = i; break; }
        if (parryIdx == null) for (const i of oppSet.normals) if (!oppSet.spent.has(i)) { parryIdx = i; break; }
        if (parryIdx != null) oppSet.spent.add(parryIdx);
      }
      const otherSide = side === 'A' ? 'T' : 'A';
      if (remainingFightDice(f, otherSide) > 0) f.next = otherSide;
    }
    f.step = 'resolving';
  }

  function commitFight() {
    const f = state.combat.fight;
    if (!f) return;
    pushUndo();
    const a = activation();
    a.ap -= RC.FIGHT_AP;
    a.hasFought = true;
    f.attacker.hp = Math.max(0, f.attacker.hp - f.damageA);
    f.target.hp = Math.max(0, f.target.hp - f.damageT);
    if (f.attacker.hp <= 0) {
      f.attacker.alive = false; f.attacker.unitState = 'incapacitated';
      log(`${f.attacker.letter} is slain in melee.`, 'kill');
      registerKill(f.target.team);
    }
    if (f.target.hp <= 0) {
      f.target.alive = false; f.target.unitState = 'incapacitated';
      log(`${f.target.letter} is slain in melee.`, 'kill');
      registerKill(f.attacker.team);
    }
    a.history.push({ type: 'fight', target: f.target.letter, dmg: f.damageT, taken: f.damageA });
    closeFightModal();
    if (checkVictory()) return;
    syncActivationPanel();
    render();
  }

  // ── Wire panel buttons ────────────────────────────────────────────
  document.querySelectorAll('#activation-orders [data-order]').forEach(b => {
    b.addEventListener('click', () => pickOrder(b.dataset.order));
  });
  undoBtn.addEventListener('click', applyUndo);
  endActivationBtn.addEventListener('click', endActivation);
  shootCancel.addEventListener('click', closeShootModal);
  fightCancel.addEventListener('click', closeFightModal);

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
    const isActive = state.phase === 'combat' && activation() && activation().unit === u;
    div.className = 'unit-row'
      + ((isSelected || isPending || isActive) ? ' selected' : '')
      + (u.alive ? '' : ' dead');
    if (isDeploying && !u.deployed) div.classList.add('undeployed');

    // State / order chips for combat readability.
    let chips = '';
    if (state.phase === 'combat' || state.phase === 'over') {
      if (!u.alive) chips += `<span class="state-chip activated">Down</span>`;
      else if (u.unitState === 'activated') chips += `<span class="state-chip activated">Activated</span>`;
      else if (u.unitState === 'activating') chips += `<span class="state-chip ready">Active</span>`;
      else chips += `<span class="state-chip ready">Ready</span>`;
      if (u.alive && u.order === 'engage') chips += `<span class="state-chip engage">Engage</span>`;
      if (u.alive && u.order === 'conceal') chips += `<span class="state-chip conceal">Conceal</span>`;
    }

    div.innerHTML = `
      <div class="swatch" style="background:${ti.color};">${u.letter}</div>
      <div class="meta">
        <div class="name">${escapeHtml(u._displayName)}${chips}</div>
        <div class="stats"></div>
      </div>`;
    const statsEl = div.querySelector('.stats');
    if (state.phase === 'deploy') {
      statsEl.textContent = u.deployed
        ? `Deployed · Sv ${u.save}+ · W ${u.wounds}`
        : `Awaiting deploy · Sv ${u.save}+ · W ${u.wounds}`;
    } else {
      const apStr = isActive ? `AP ${activation().ap}/${activation().apMax}` : `APL ${u.apl}`;
      statsEl.textContent =
        `HP ${u.alive ? u.hp : 0}/${u.maxHp} · ${apStr} · Sv ${u.save}+ · M ${u.moveInches}"`;
    }

    div.addEventListener('mouseenter', () => showStatBlock(u, null));
    div.addEventListener('mouseleave', () => hideStatBlock());
    div.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.phase === 'deploy' && u.team === state.deploy.currentTeam) {
        if (u.deployed) undeployUnit(u);
        else selectPendingUnit(u);
        return;
      }
      // Combat: tap an active-team ready unit to start its activation.
      if (state.phase === 'combat' && u.alive && u.team === activeTeam() && !activation() && u.unitState === 'ready') {
        startActivation(u);
        return;
      }
      // Combat: tap an enemy in CR while activating to fight; tap an enemy
      // to shoot if we're in shoot-target mode (handled via the modal).
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

  function renderVpBoard() {
    if (!vpBoardEl) return;
    if (state.phase !== 'combat' && state.phase !== 'over') {
      vpBoardEl.style.display = 'none';
      return;
    }
    vpBoardEl.style.display = '';
    const labelFor = (team) => state.rosters[team]
      ? (state.rosters[team].name || TEAM_INFO[team].name)
      : TEAM_INFO[team].name;
    document.getElementById('vp-name-A').textContent = labelFor('A');
    document.getElementById('vp-name-B').textContent = labelFor('B');
    document.getElementById('vp-total-A').textContent = totalVP('A');
    document.getElementById('vp-total-B').textContent = totalVP('B');
    document.getElementById('vp-kill-A').textContent  = state.score.killOp.A;
    document.getElementById('vp-kill-B').textContent  = state.score.killOp.B;
    document.getElementById('vp-crit-A').textContent  = state.score.critOp.A;
    document.getElementById('vp-crit-B').textContent  = state.score.critOp.B;
    document.getElementById('vp-kills-A').textContent = state.score.kills.A;
    document.getElementById('vp-kills-B').textContent = state.score.kills.B;
    document.getElementById('vp-size-A').textContent  = state.score.startSize.B;
    document.getElementById('vp-size-B').textContent  = state.score.startSize.A;
    // Highlight which side currently leads in projected crit-op control.
    const live = liveObjectiveTally();
    const aSide = vpBoardEl.querySelector('.vp-side[data-team="A"]');
    const bSide = vpBoardEl.querySelector('.vp-side[data-team="B"]');
    aSide.classList.toggle('controlling', live.A > live.B && live.A > 0);
    bSide.classList.toggle('controlling', live.B > live.A && live.B > 0);
  }

  // How many objectives each team is currently projected to score this TP
  // if the round were to end now. Used purely for live HUD feedback.
  function liveObjectiveTally() {
    const tally = { A: 0, B: 0, neutral: 0 };
    for (const o of (mapDef.objectives || [])) {
      tally[objectiveControl(o)]++;
    }
    return tally;
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
      phaseChip.textContent = `Turning Point ${state.combat.turningPoint}`;
      batchChip.style.display = '';
      const a = activation();
      if (a) batchChip.textContent = `${a.unit.letter} · AP ${a.ap}/${a.apMax}`;
      else {
        const ready = readyUnits(activeTeam()).length;
        batchChip.textContent = ready ? `${ready} ready` : 'No ready units';
      }
      const team = activeTeam();
      const rname = state.rosters[team] ? (state.rosters[team].name || TEAM_INFO[team].name) : TEAM_INFO[team].name;
      turnBanner.textContent = a ? `${a.unit.letter} activating` : `${rname} to pick`;
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

    // Objectives — during combat the marker shows live control (combined APL
    // within 1") as a halo, while still rendering the map's authored owner
    // on the inner disc.
    const inCombat = (state.phase === 'combat' || state.phase === 'over');
    for (const o of mapDef.objectives || []) {
      const ctrl = inCombat ? objectiveControl(o) : null;
      // 1" control radius (only shown in combat).
      if (inCombat) {
        const rad = RC.ENGAGEMENT_RANGE * s;
        if (ctrl === 'A' || ctrl === 'B') {
          const tinted = ctrl === 'A' ? '58, 109, 184' : '184, 32, 58';
          ctx.fillStyle = `rgba(${tinted}, 0.18)`;
          ctx.beginPath();
          ctx.arc(o.x * s, o.y * s, rad, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `rgba(${tinted}, 0.8)`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(o.x * s, o.y * s, rad, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.18)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.arc(o.x * s, o.y * s, rad, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
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

    // Movement preview (combat) — only when an action is armed.
    if (state.phase === 'combat') {
      const a = activation();
      const pm = state.combat.pendingMove;
      if (a && pm) {
        const u = a.unit;
        const last = pm.waypoints[pm.waypoints.length - 1];
        const remaining = Math.max(0, pm.maxInches - pm.used);

        // Enemy control-range bubbles (1") so the user can see the no-go
        // zones for Reposition / Dash and the must-end-in zone for Charge.
        const enemies = state.units.filter(o => o.alive && o.deployed && o.team !== u.team);
        const showCRColor = (pm.kind === 'reposition' || pm.kind === 'dash')
          ? 'rgba(184,32,58,0.18)'
          : (pm.kind === 'charge' ? 'rgba(122,156,62,0.18)' : 'rgba(122,156,62,0.10)');
        const showCRStroke = (pm.kind === 'reposition' || pm.kind === 'dash')
          ? 'rgba(184,32,58,0.55)'
          : (pm.kind === 'charge' ? 'rgba(122,156,62,0.65)' : 'rgba(122,156,62,0.40)');
        for (const e of enemies) {
          ctx.fillStyle = showCRColor;
          ctx.strokeStyle = showCRStroke;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(e.x * s, e.y * s, RC.ENGAGEMENT_RANGE * s, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        // Remaining-budget circle around the last committed waypoint.
        ctx.strokeStyle = 'rgba(201,167,77,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(last.x * s, last.y * s, remaining * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Path so far — solid gold polyline.
        ctx.strokeStyle = 'rgba(201,167,77,0.95)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(pm.waypoints[0].x * s, pm.waypoints[0].y * s);
        for (let i = 1; i < pm.waypoints.length; i++) {
          ctx.lineTo(pm.waypoints[i].x * s, pm.waypoints[i].y * s);
        }
        ctx.stroke();
        // Waypoint markers.
        for (let i = 1; i < pm.waypoints.length; i++) {
          ctx.fillStyle = '#fff8e0';
          ctx.beginPath();
          ctx.arc(pm.waypoints[i].x * s, pm.waypoints[i].y * s, 3, 0, Math.PI * 2);
          ctx.fill();
        }

        // In-progress leg from the last waypoint to the cursor.
        if (state.combat.hoverPt) {
          const reason = canExtendPathReason(u, pm, state.combat.hoverPt.x, state.combat.hoverPt.y);
          ctx.strokeStyle = reason ? 'rgba(184,32,58,0.85)' : 'rgba(201,167,77,0.95)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(last.x * s, last.y * s);
          ctx.lineTo(state.combat.hoverPt.x * s, state.combat.hoverPt.y * s);
          ctx.stroke();
          ctx.setLineDash([]);
          const { rx, ry } = unitRadii(u);
          ctx.beginPath();
          ctx.ellipse(state.combat.hoverPt.x * s, state.combat.hoverPt.y * s, rx * s, ry * s, 0, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Ghost outline at the path's current endpoint so you can see the
        // unit's footprint at the proposed final position.
        if (pm.waypoints.length > 1) {
          const { rx, ry } = unitRadii(u);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.ellipse(last.x * s, last.y * s, rx * s, ry * s, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Highlight openable hatchways/breaches relative to the active unit.
      if (a) {
        const u = a.unit;
        for (const o of (mapDef.openable || [])) {
          const d = Math.hypot(o.x - u.x, o.y - u.y);
          if (d > 4) continue;
          const isOpen = state.combat.pieceState.open.has(o.pieceIndex);
          ctx.strokeStyle = d <= 1
            ? (o.kind === 'hatchway' ? 'rgba(122,156,62,0.85)' : 'rgba(201,122,58,0.85)')
            : 'rgba(255,255,255,0.18)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(o.x * s, o.y * s, 0.7 * s, 0, Math.PI * 2);
          ctx.stroke();
          if (isOpen) {
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(o.x * s - 0.5 * s, o.y * s - 0.1 * s, 1 * s, 0.2 * s);
          }
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
    renderVpBoard();
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
      const a = activation();

      // Pre-activation: tap a ready friendly to start their activation;
      // tap any other unit to view its stat block.
      if (!a) {
        if (clicked && clicked.alive && clicked.team === activeTeam() && clicked.unitState === 'ready') {
          startActivation(clicked);
          return;
        }
        if (clicked) showStatBlock(clicked, evt, true);
        return;
      }

      // During an activation:
      // 1. If a move action is armed (pendingMove), each click extends the
      //    path by one waypoint. The user presses Confirm in the activation
      //    panel to commit the move and pay AP.
      // 2. Otherwise, tapping our own unit re-pins selection; tapping an
      //    enemy reveals their stat block.
      const pm = state.combat.pendingMove;
      if (pm) {
        if (clicked && clicked.alive) {
          // Don't try to add a waypoint on top of an operative — show its
          // stat block instead so taps feel responsive.
          showStatBlock(clicked, evt, true);
          return;
        }
        addWaypoint(p.x, p.y);
        return;
      }

      if (clicked && clicked.alive) {
        showStatBlock(clicked, evt, true);
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
    state.combat = {
      turningPoint: 1, initiativeTeam: 'A', activeTeam: 'A',
      selectedId: null, activation: null, pendingMove: null,
      shoot: null, fight: null, pieceState: { open: new Set() },
      hoverPt: null, over: false,
    };
    state.score = {
      killOp: { A: 0, B: 0 }, critOp: { A: 0, B: 0 },
      kills:  { A: 0, B: 0 }, startSize: { A: 0, B: 0 },
      lastScoredTP: 0,
    };
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
