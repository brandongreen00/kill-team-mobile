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
  // back to the default Approved Ops map silently in that case.
  const DEFAULT_MAP_ID = 'tomb-approved-2';
  let mapId = DEFAULT_MAP_ID;
  try { mapId = sessionStorage.getItem('kt.mapId') || DEFAULT_MAP_ID; } catch (e) {}
  const mapDefRaw = KT.getMap(mapId) || KT.TOMB_MAPS[DEFAULT_MAP_ID];
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
      // Apply the roster loadout: when a ranged / melee choice was made at
      // list-build, only that base weapon (all its firing modes) plus any
      // Limited extras come along. Without a choice all weapons remain.
      const weaponBaseName = (n) => String(n || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      const isLimitedWeapon = (w) =>
        Array.isArray(w && w.rules) && w.rules.some(r => /^Limited\b/i.test(String(r || '')));
      // A choice may be a single base name (roster editor) or an array of
      // base names (preset loadouts that carry e.g. a pistol AND a heavy gun).
      const matchesChoice = (w, choice) => {
        if (!choice) return true;
        const bases = Array.isArray(choice) ? choice : [choice];
        return bases.some(c => weaponBaseName(w.name) === weaponBaseName(c));
      };
      const weapons = (op.weapons || []).filter(w => {
        if (isLimitedWeapon(w)) return true;
        return matchesChoice(w, w.is_melee ? pick.meleeChoice : pick.rangedChoice);
      });
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
        aplMod: 0,               // Stun / concussion; clamped ±1, expires after next activation
        onGuard: false,          // set by the Guard action; allows an interrupt
        hasCounteracted: false,  // one counteract per operative per turning point
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
      cp: { A: 0, B: 0 },          // command points
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
      tacOp:     { A: 0, B: 0 },     // secret-objective VP (max 6)
      kills:     { A: 0, B: 0 },     // # enemies this team has incapacitated
      startSize: { A: 0, B: 0 },     // enemy starting size at game start
      lastScoredTP: 0,               // guards crit-op against double-scoring
    },

    // Pre-game op selections (team screen). critOpChoice 'random' rolls at
    // battle start; tacOpChoice is per side.
    critOpChoice: 'random',
    tacOpChoice: { A: null, B: null },

    // Solo mode: which side (if any) the AI commands.
    aiTeam: null,

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
  // among operatives within 1" of the marker is greater. Distance is
  // measured from the operative's BASE EDGE, not its centre. Ties are neutral.
  function objectiveControl(obj) {
    let aSum = 0, bSum = 0;
    for (const u of state.units) {
      if (!u.alive || !u.deployed) continue;
      const d = Math.hypot(u.x - obj.x, u.y - obj.y) - KTR.unitBaseRadius(u);
      if (d <= RC.ENGAGEMENT_RANGE + 1e-3) {
        if (u.team === 'A') aSum += KTR.effectiveAPL(u);
        else                bSum += KTR.effectiveAPL(u);
      }
    }
    if (aSum > bSum) return 'A';
    if (bSum > aSum) return 'B';
    return 'neutral';
  }

  // ── Ops engine (crit op + tac ops) ──────────────────────────────────
  const OPS = window.KT_OPS;
  const CRIT_OP_VP_CAP = 6;
  const TAC_OP_VP_CAP = 6;

  function opsState() { return state.combat.ops; }
  function enemyOf(team) { return team === 'A' ? 'B' : 'A'; }

  function initOps() {
    const critId = (state.critOpChoice === 'random' || !state.critOpChoice)
      ? OPS.CRIT_OPS[Math.floor(Math.random() * OPS.CRIT_OPS.length)].id
      : state.critOpChoice;
    const mkTacOp = (team) => {
      const id = state.tacOpChoice[team];
      if (!id || !OPS.tacOpById(id)) return null;
      return {
        id,
        dominateTokens: {},                                  // unitIndex -> tokens
        martyrTokens: (mapDef.objectives || []).map(() => 0),
        deviceTokens: (mapDef.objectives || []).map(() => false),
        monitored: new Set(),                                // enemy unit indexes
        envoyIdx: null,
        envoyUsed: new Set(),
        envoyStartHp: 0,
        flankPrev: { a: false, b: false },                   // controlled at end of prev TP
      };
    };
    state.combat.ops = {
      critOp: critId,
      objState: (mapDef.objectives || []).map(() => ({ securedBy: null, transmitting: false, lootedTP: 0 })),
      lootVPThisTP: { A: 0, B: 0 },
      routVPThisTP: { A: 0, B: 0 },
      tacOps: { A: mkTacOp('A'), B: mkTacOp('B') },
    };
    log(`Crit Op: ${OPS.critOpById(critId).name}.`, 'turn');
    ['A', 'B'].forEach(t => {
      const to = state.combat.ops.tacOps[t];
      if (to) log(`${teamName(t)} Tac Op: ${OPS.tacOpById(to.id).name}.`, 'turn');
    });
  }

  function addCritVP(team, n, why) {
    if (n <= 0) return;
    const gain = Math.min(n, CRIT_OP_VP_CAP - state.score.critOp[team]);
    if (gain <= 0) return;
    state.score.critOp[team] += gain;
    log(`${teamName(team)} scores ${gain}VP (${why}).`, 'turn');
  }
  function addTacVP(team, n, why) {
    if (n <= 0) return;
    const gain = Math.min(n, TAC_OP_VP_CAP - state.score.tacOp[team]);
    if (gain <= 0) return;
    state.score.tacOp[team] += gain;
    log(`${teamName(team)} scores ${gain}VP (Tac Op — ${why}).`, 'turn');
  }

  function unitContests(u, obj) {
    return u.alive && u.deployed
      && Math.hypot(u.x - obj.x, u.y - obj.y) - KTR.unitBaseRadius(u) <= RC.ENGAGEMENT_RANGE + 1e-3;
  }

  // Distance from a unit to a team's drop zone (deploy squares or half).
  function distToDropZone(u, team) {
    const squares = KT.deploySquares(mapDef, team);
    const rects = squares.length ? squares : [KT.deployZone(mapDef, team)];
    let best = Infinity;
    for (const z of rects) {
      const dx = Math.max(z.x - u.x, 0, u.x - (z.x + z.w));
      const dy = Math.max(z.y - u.y, 0, u.y - (z.y + z.h));
      best = Math.min(best, Math.hypot(dx, dy));
    }
    return best;
  }

  // Is the unit wholly within `team`'s half of the board?
  function whollyInTerritory(u, team) {
    const z = KT.deployZone(mapDef, team); // full half of the board
    const r = KTR.unitBaseRadius(u);
    return u.x - r >= z.x && u.x + r <= z.x + z.w
        && u.y - r >= z.y && u.y + r <= z.y + z.h;
  }

  // Kill hooks (Rout / Dominate / Martyrs).
  function onKillScored(killerTeam, killer, victim) {
    const ops = opsState();
    if (!ops) return;
    const myOp = ops.tacOps[killerTeam];
    if (myOp && killer) {
      if (myOp.id === 'rout') {
        if (distToDropZone(killer, enemyOf(killerTeam)) <= 6 + 1e-3 && ops.routVPThisTP[killerTeam] < 2) {
          const vp = Math.min((victim && victim.maxHp >= 12) ? 2 : 1, 2 - ops.routVPThisTP[killerTeam]);
          ops.routVPThisTP[killerTeam] += vp;
          addTacVP(killerTeam, vp, 'Rout');
        }
      } else if (myOp.id === 'dominate') {
        const idx = state.units.indexOf(killer);
        if (idx >= 0) {
          const tokens = (victim && victim.maxHp >= 12) ? 2 : 1;
          myOp.dominateTokens[idx] = (myOp.dominateTokens[idx] || 0) + tokens;
          log(`${killer.letter} claims ${tokens} Dominate token${tokens > 1 ? 's' : ''}.`);
        }
      }
    }
    // Martyrs triggers for the *victim's* team.
    if (victim) {
      const victimOp = ops.tacOps[victim.team];
      if (victimOp && victimOp.id === 'martyrs') {
        (mapDef.objectives || []).forEach((obj, i) => {
          if (unitContestsIncapacitated(victim, obj)) {
            victimOp.martyrTokens[i] += 1;
            log(`A martyr falls on objective ${i + 1}.`);
          }
        });
      }
    }
  }
  // The victim is already flagged !alive when the hook runs — test position only.
  function unitContestsIncapacitated(u, obj) {
    return u.deployed
      && Math.hypot(u.x - obj.x, u.y - obj.y) - KTR.unitBaseRadius(u) <= RC.ENGAGEMENT_RANGE + 1e-3;
  }

  // Valid-target check used by Track Enemy (visible and not conceal+cover).
  function isValidTarget(shooter, target) {
    const env = KTR.shootEnv(mapDef, state.combat.pieceState.open, shooter, target);
    if (!env.visible) return false;
    if (target.order === 'conceal' && env.inCover) return false;
    return true;
  }

  // Flanks: the dividing line runs through the centre of each player's
  // killzone edge (perpendicular to the deployment split). Returns 'a'|'b'
  // for whichever flank the unit is wholly within, else null.
  function flankOf(u) {
    const r = KTR.unitBaseRadius(u);
    if (mapDef.split === 'vertical') {
      const mid = BOARD.height / 2;
      if (u.y + r <= mid) return 'a';
      if (u.y - r >= mid) return 'b';
    } else {
      const mid = BOARD.width / 2;
      if (u.x + r <= mid) return 'a';
      if (u.x - r >= mid) return 'b';
    }
    return null;
  }
  function flankControlled(team, flank) {
    let mine = 0, theirs = 0;
    for (const u of state.units) {
      if (!u.alive || !u.deployed) continue;
      if (!whollyInTerritory(u, enemyOf(team))) continue;
      if (flankOf(u) !== flank) continue;
      if (u.team === team) mine += KTR.effectiveAPL(u);
      else theirs += KTR.effectiveAPL(u);
    }
    return mine > theirs;
  }

  // Score the turning point that just ended: crit op then both tac ops.
  // Guarded so a single TP can never score twice (covers the case where the
  // game ends mid-TP via elimination).
  function scoreEndOfTurningPoint() {
    const tp = state.combat.turningPoint;
    if (state.score.lastScoredTP >= tp) return;
    state.score.lastScoredTP = tp;
    const ops = opsState();
    if (!ops) return;
    if (tp >= 2) {
      scoreCritOpForTP(ops, tp);
      ['A', 'B'].forEach(team => scoreTacOpForTP(team, ops, tp));
    }
    // Per-TP housekeeping.
    ops.objState.forEach(o => { o.transmitting = false; });
    ops.lootVPThisTP = { A: 0, B: 0 };
    ops.routVPThisTP = { A: 0, B: 0 };
    ['A', 'B'].forEach(team => {
      const to = ops.tacOps[team];
      if (to) to.monitored = new Set();
    });
  }

  function scoreCritOpForTP(ops, tp) {
    const objs = mapDef.objectives || [];
    if (ops.critOp === 'secure') {
      const counts = { A: 0, B: 0 };
      objs.forEach((o, i) => {
        const s = ops.objState[i].securedBy;
        if (s) counts[s]++;
      });
      ['A', 'B'].forEach(t => {
        let vp = 0;
        if (counts[t] > 0) vp++;
        if (counts[t] > counts[enemyOf(t)]) vp++;
        addCritVP(t, vp, 'Secure');
      });
    } else if (ops.critOp === 'transmission') {
      const counts = { A: 0, B: 0 };
      objs.forEach((o, i) => {
        if (!ops.objState[i].transmitting) return;
        const c = objectiveControl(o);
        if (c === 'A' || c === 'B') counts[c]++;
      });
      ['A', 'B'].forEach(t => {
        let vp = 0;
        if (counts[t] > 0) vp++;
        if (counts[t] > counts[enemyOf(t)]) vp++;
        addCritVP(t, vp, 'Transmission');
      });
    }
    // Loot scores immediately when the action is performed.
  }

  function scoreTacOpForTP(team, ops, tp) {
    const to = ops.tacOps[team];
    if (!to) return;
    const objs = mapDef.objectives || [];
    const enemy = enemyOf(team);
    switch (to.id) {
      case 'dominate': {
        if (tp === 3 || tp === 4) {
          let vp = 0;
          for (const [idxStr, tokens] of Object.entries(to.dominateTokens)) {
            const u = state.units[+idxStr];
            if (u && u.alive) { vp += tokens; to.dominateTokens[idxStr] = 0; }
          }
          addTacVP(team, Math.min(3, vp), 'Dominate');
        }
        break;
      }
      case 'martyrs': {
        let vp = 0;
        objs.forEach((obj, i) => {
          if (to.martyrTokens[i] <= 0) return;
          const contested = state.units.some(u => u.team === team && unitContests(u, obj));
          if (!contested) return;
          const controlled = objectiveControl(obj) === team;
          vp += to.martyrTokens[i] * (controlled ? 2 : 1);
          to.martyrTokens[i] = 0;
        });
        addTacVP(team, Math.min(2, vp), 'Martyrs');
        break;
      }
      case 'envoy': {
        const envoy = to.envoyIdx != null ? state.units[to.envoyIdx] : null;
        if (envoy && envoy.alive && whollyInTerritory(envoy, enemy)
            && !KTR.inEnemyControlRange(envoy, state.units)) {
          const unhurt = envoy.hp >= to.envoyStartHp;
          addTacVP(team, unhurt ? 2 : 1, 'Envoy');
        }
        break;
      }
      case 'flank': {
        let vp = 0;
        const now = { a: flankControlled(team, 'a'), b: flankControlled(team, 'b') };
        ['a', 'b'].forEach(f => {
          if (!now[f]) return;
          vp += (tp === 4 && to.flankPrev[f]) ? 2 : 1;
        });
        to.flankPrev = now;
        addTacVP(team, Math.min(2, vp), 'Flank');
        break;
      }
      case 'scout': {
        let vp = 0;
        for (const idx of to.monitored) {
          const e = state.units[idx];
          if (!e || !e.alive) continue;
          const seen = state.units.some(f => f.team === team && f.alive && f.deployed
            && KTR.shootEnv(mapDef, state.combat.pieceState.open, f, e).visible);
          if (seen) vp++;
        }
        addTacVP(team, Math.min(2, vp), 'Scout Enemy Movement');
        break;
      }
      case 'track': {
        let tracked = 0;
        for (const e of state.units) {
          if (!e.alive || !e.deployed || e.team !== enemy) continue;
          const isTracked = state.units.some(f => {
            if (f.team !== team || !f.alive || !f.deployed) return false;
            if (f.order !== 'conceal') return false;
            if (KTR.edgeDist(f, e) > 6 + 1e-3) return false;
            if (KTR.inEnemyControlRange(f, state.units)) return false;
            return isValidTarget(f, e) && !isValidTarget(e, f);
          });
          if (isTracked) tracked++;
        }
        let vp = 0;
        if (tracked >= 2) vp = 2;
        else if (tracked === 1) vp = (tp === 4) ? 2 : 1;
        addTacVP(team, vp, 'Track Enemy');
        break;
      }
      case 'plant-devices': {
        let vp = 0;
        objs.forEach((obj, i) => {
          if (!to.deviceTokens[i]) return;
          if (obj.owner === enemy) vp++;
          else if (state.units.some(u => u.team === enemy && unitContests(u, obj))) vp++;
        });
        addTacVP(team, Math.min(2, vp), 'Plant Devices');
        break;
      }
      // rout scores immediately via onKillScored.
    }
  }

  // Envoy auto-selection at the start of each TP after the first: the
  // surviving friendly deepest toward (or into) enemy territory that hasn't
  // served as envoy before.
  function selectEnvoys() {
    const ops = opsState();
    if (!ops) return;
    ['A', 'B'].forEach(team => {
      const to = ops.tacOps[team];
      if (!to || to.id !== 'envoy') return;
      const enemy = enemyOf(team);
      const depth = (u) => {
        if (mapDef.split === 'vertical') return enemy === 'B' ? u.x : -u.x;
        return enemy === 'B' ? -u.y : u.y;
      };
      let best = null, bestDepth = -Infinity;
      state.units.forEach((u, idx) => {
        if (u.team !== team || !u.alive || !u.deployed) return;
        if (to.envoyUsed.has(idx)) return;
        const d = depth(u);
        if (d > bestDepth) { bestDepth = d; best = idx; }
      });
      to.envoyIdx = best;
      if (best != null) {
        to.envoyUsed.add(best);
        to.envoyStartHp = state.units[best].hp;
        log(`${teamName(team)} appoints ${state.units[best].letter} as Envoy.`);
      }
    });
  }

  function totalVP(team) {
    return (state.score.killOp[team] || 0) + (state.score.critOp[team] || 0)
      + (state.score.tacOp[team] || 0);
  }

  // Called whenever an enemy is incapacitated. `killerTeam` is the team that
  // scored the kill; `killer` / `victim` (optional) feed tac-op hooks.
  function registerKill(killerTeam, killer, victim) {
    if (killerTeam !== 'A' && killerTeam !== 'B') return;
    state.score.kills[killerTeam] = (state.score.kills[killerTeam] || 0) + 1;
    recomputeKillOp();
    onKillScored(killerTeam, killer || null, victim || null);
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
  const actionGridMore = document.getElementById('action-grid-more');
  const actionMoreToggle = document.getElementById('action-more-toggle');
  const undoBtn = document.getElementById('undo-btn');
  const endActivationBtn = document.getElementById('end-activation-btn');
  const activationHint = document.getElementById('activation-hint');
  const activationCollapse = document.getElementById('activation-collapse');
  const miniHud = document.getElementById('board-mini-hud');
  const miniHudLetter = document.getElementById('mh-letter');
  const miniHudName = document.getElementById('mh-name');
  const miniHudAp = document.getElementById('mh-ap');
  const miniHudOrder = document.getElementById('mh-order');
  const miniHudHp = document.getElementById('mh-hp');
  const sidebarEl = document.getElementById('sidebar');
  const rosterToggle = document.getElementById('roster-toggle');
  const sidebarClose = document.getElementById('sidebar-close');
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
  // Saved rosters (if any) render first, then the built-in preset kill
  // teams — so a first-time player can start a game with zero setup.
  const PRESET_ROSTERS = (window.KT_PRESETS || []).filter(p => FACTIONS_BY_ID[p.factionId]);
  function renderTeamPicker() {
    const rosters = loadRosters();
    ['A', 'B'].forEach(team => {
      const list = document.getElementById('roster-list-' + team);
      list.innerHTML = '';
      const addHeading = (text) => {
        const h = document.createElement('div');
        h.className = 'roster-pick-heading';
        h.textContent = text;
        list.appendChild(h);
      };
      const addCard = (r, isPreset) => {
        const f = FACTIONS_BY_ID[r.factionId];
        const card = document.createElement('div');
        card.className = 'roster-pick-card' + (isPreset ? ' preset' : '');
        card.dataset.rosterId = r.id;
        card.innerHTML = `
          <div class="roster-pick-name"></div>
          <div class="roster-pick-meta"></div>
        `;
        card.querySelector('.roster-pick-name').textContent = r.name || 'Untitled Kill Team';
        card.querySelector('.roster-pick-meta').textContent =
          (f ? f.name : '—') + ' · ' + r.picks.length + ' operative' + (r.picks.length === 1 ? '' : 's')
          + (isPreset && r.blurb ? ' · ' + r.blurb : '');
        card.addEventListener('click', () => selectRoster(team, r));
        if (state.rosters[team] && state.rosters[team].id === r.id) {
          card.classList.add('selected');
        }
        list.appendChild(card);
      };
      if (rosters.length) {
        addHeading('Your rosters');
        rosters.forEach(r => addCard(r, false));
      }
      if (PRESET_ROSTERS.length) {
        addHeading('Preset kill teams');
        PRESET_ROSTERS.forEach(r => addCard(r, true));
      }
      if (!rosters.length && !PRESET_ROSTERS.length) {
        const empty = document.createElement('div');
        empty.className = 'roster-empty-state';
        empty.style.padding = '20px 12px';
        empty.textContent = 'No rosters saved. Build one from the Roster screen.';
        list.appendChild(empty);
      }
    });
    updateTeamPickerUI();
  }

  function selectRoster(team, roster) {
    state.rosters[team] = roster;
    document.querySelectorAll('#roster-list-' + team + ' .roster-pick-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.rosterId === roster.id);
    });
    syncTacOpSelect(team);
    updateTeamPickerUI();
  }

  // ── Ops selection (team screen) ──────────────────────────────────────
  function initOpsPickers() {
    const critSel = document.getElementById('crit-op-select');
    if (!critSel || !OPS) return;
    OPS.CRIT_OPS.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      critSel.appendChild(o);
    });
    const critDesc = document.getElementById('crit-op-desc');
    const syncCrit = () => {
      state.critOpChoice = critSel.value;
      const c = OPS.critOpById(critSel.value);
      critDesc.textContent = c ? c.summary : 'One of the three crit ops, rolled at battle start.';
    };
    critSel.addEventListener('change', syncCrit);
    syncCrit();
  }

  function syncTacOpSelect(team) {
    const sel = document.getElementById('tac-op-' + team);
    const desc = document.getElementById('tac-op-desc-' + team);
    if (!sel || !OPS) return;
    const roster = state.rosters[team];
    sel.innerHTML = '';
    if (!roster) {
      sel.disabled = true;
      desc.textContent = '';
      state.tacOpChoice[team] = null;
      return;
    }
    sel.disabled = false;
    const opts = OPS.tacOpsFor(roster.factionId);
    opts.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = `${t.name} (${t.archetype})`;
      sel.appendChild(o);
    });
    const sync = () => {
      state.tacOpChoice[team] = sel.value;
      const t = OPS.tacOpById(sel.value);
      desc.textContent = t ? t.summary : '';
    };
    sel.onchange = sync;
    // Keep a previously chosen op if it's still legal for the new faction.
    if (state.tacOpChoice[team] && opts.some(t => t.id === state.tacOpChoice[team])) {
      sel.value = state.tacOpChoice[team];
    }
    sync();
  }
  initOpsPickers();

  // Solo mode toggle: the AI commands Red. Enabling it with no roster
  // chosen auto-picks the Plague Marines preset (the recommended first AI
  // team — few, durable operatives with simple decisions).
  const aiToggleB = document.getElementById('ai-toggle-B');
  if (aiToggleB) {
    aiToggleB.addEventListener('change', () => {
      state.aiTeam = aiToggleB.checked ? 'B' : null;
      if (aiToggleB.checked && window.KT_AI) window.KT_AI.poke();
      if (aiToggleB.checked && !state.rosters.B) {
        const plague = PRESET_ROSTERS.find(p => p.factionId === 'plague-marines') || PRESET_ROSTERS[0];
        if (plague) selectRoster('B', plague);
      }
      // The AI plays Dominate best (kills score anywhere, no positioning).
      if (aiToggleB.checked) {
        const selB = document.getElementById('tac-op-B');
        if (selB && Array.from(selB.options).some(o => o.value === 'dominate')) {
          selB.value = 'dominate';
          if (selB.onchange) selB.onchange();
        }
      }
      updateTeamPickerUI();
    });
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
    state.score.tacOp = { A: 0, B: 0 };
    initOps();
    // TP1 initiative goes to whoever deployed first (the setup roll-off
    // winner's choice); later TPs roll off in each Strategy phase.
    state.combat.initiativeTeam = state.deploy.first;
    state.combat.activeTeam = state.deploy.first;
    // Approved Ops: each player starts the battle with 2CP, then gains 1CP
    // in the first Ready step.
    state.combat.cp = { A: 2 + RC.CP_PER_TP, B: 2 + RC.CP_PER_TP };
    state.combat.usedPloys = { A: new Set(), B: new Set() };
    state.combat.activePloys = { A: [], B: [] };
    state.units.forEach(u => {
      if (u.alive) {
        u.unitState = 'ready'; u.order = null; u.ap = u.apl;
        u.onGuard = false; u.hasCounteracted = false;
      }
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
    // Activating while a counteract offer is open counts as the opposing
    // player passing on it.
    if (state.combat.counteract && state.combat.counteract.selecting) {
      state.combat.counteract = null;
    }
    unit.unitState = 'activating';
    unit.ap = KTR.effectiveAPL(unit);
    unit.onGuard = false;
    // Default to Engage so the player can act immediately. They can flip to
    // Conceal via the chip in the activation header until the first action
    // is taken (Kill Team locks the order once a decision depends on it).
    unit.order = 'engage';
    state.combat.selectedId = unit;
    state.combat.activation = {
      unit,
      order: 'engage',
      ap: unit.ap,
      apMax: unit.ap,
      history: [],
      undoStack: [],
      hasReposition: false,
      hasDashed: false,
      hasCharged: false,
      hasFallenBack: false,
      hasShot: false,
      hasFought: false,
      hasGuard: false,
      teleportedThisActivation: false,
      // baseline snapshot so the user can undo back to "before this activation".
      baseline: null,
    };
    state.combat.activation.baseline = snapshotForUndo();
    log(`${teamName(unit.team)} activates ${unit.letter} (${unit._displayName}) — Engage.`, 'turn');
    state.combat.pendingMove = null;
    syncActivationPanel();
    render();
  }

  function pickOrder(order) {
    const a = activation();
    if (!a) return;
    if (a.order === order) return;
    // Locked once any action has been taken (matches Kill Team's
    // declaration-at-start rule once a choice depended on the order).
    if (a.history.length > 0) return;
    a.order = order;
    a.unit.order = order;
    log(`${a.unit.letter} switches to ${order === 'engage' ? 'Engage' : 'Conceal'}.`);
    syncActivationPanel();
    render();
  }

  function renderOrderChip(order, locked) {
    const label = order === 'conceal' ? 'Conceal' : 'Engage';
    const next = order === 'conceal' ? 'engage' : 'conceal';
    if (locked) {
      return `<span class="order-chip order-${order} locked" title="Order locks after the first action">${label}</span>`;
    }
    const altLabel = next === 'conceal' ? 'Conceal' : 'Engage';
    return `<span class="order-chip order-${order}" data-toggle-order="${next}" role="button" tabindex="0" title="Switch to ${altLabel}">${label} <span class="order-chip-swap">⇄</span></span>`;
  }

  function wireOrderChip() {
    const chip = activationMeta.querySelector('[data-toggle-order]');
    if (!chip) return;
    const next = chip.dataset.toggleOrder;
    const fire = () => pickOrder(next);
    chip.addEventListener('click', fire);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
    });
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
        unitState: u.unitState, order: u.order, aplMod: u.aplMod || 0,
      })),
      open: new Set(state.combat.pieceState.open),
      activeTeam: state.combat.activeTeam,
      cp: { ...state.combat.cp },
      score: JSON.parse(JSON.stringify(state.score)),
      ops: state.combat.ops ? {
        objState: JSON.parse(JSON.stringify(state.combat.ops.objState)),
        lootVPThisTP: { ...state.combat.ops.lootVPThisTP },
        routVPThisTP: { ...state.combat.ops.routVPThisTP },
        tacOps: ['A', 'B'].reduce((acc, t) => {
          const to = state.combat.ops.tacOps[t];
          acc[t] = to ? {
            dominateTokens: { ...to.dominateTokens },
            martyrTokens: [...to.martyrTokens],
            deviceTokens: [...to.deviceTokens],
            monitored: new Set(to.monitored),
          } : null;
          return acc;
        }, {}),
      } : null,
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
      u.unitState = s.unitState; u.order = s.order; u.aplMod = s.aplMod || 0;
    });
    state.combat.pieceState.open = snap.open;
    state.combat.activeTeam = snap.activeTeam;
    if (snap.cp) state.combat.cp = { ...snap.cp };
    if (snap.score) state.score = JSON.parse(JSON.stringify(snap.score));
    if (snap.ops && state.combat.ops) {
      state.combat.ops.objState = JSON.parse(JSON.stringify(snap.ops.objState));
      state.combat.ops.lootVPThisTP = { ...snap.ops.lootVPThisTP };
      state.combat.ops.routVPThisTP = { ...snap.ops.routVPThisTP };
      ['A', 'B'].forEach(t => {
        const to = state.combat.ops.tacOps[t];
        const st = snap.ops.tacOps[t];
        if (to && st) {
          to.dominateTokens = { ...st.dominateTokens };
          to.martyrTokens = [...st.martyrTokens];
          to.deviceTokens = [...st.deviceTokens];
          to.monitored = new Set(st.monitored);
        }
      });
    }
    if (snap.a && a) Object.assign(a, snap.a);
    state.combat.pendingMove = null;
    log(`Undo: reverted last action.`);
    syncActivationPanel();
    render();
  }

  function endActivation() {
    const a = activation();
    if (!a) return;
    if (a.counteract) { endCounteract(); return; }
    if (!a.order) {
      activationHint.textContent = 'Pick an order before ending the activation.';
      activationHint.classList.add('warn');
      return;
    }
    const u = a.unit;
    u.unitState = 'activated';
    // Stun / concussion APL penalties last until the end of the operative's
    // next activation — which has just ended.
    u.aplMod = 0;
    log(`${u.letter} ends activation.`, 'turn');
    state.combat.activation = null;
    state.combat.pendingMove = null;
    advanceAfterActivation(u.team);
  }

  // Alternation after an activation (or counteract) resolves. When one side
  // is fully expended but the other still has ready operatives, the expended
  // side is offered a counteract before each remaining enemy activation.
  function advanceAfterActivation(justActedTeam) {
    const other = justActedTeam === 'A' ? 'B' : 'A';
    const readyOther = readyUnits(other).length;
    const readyCur = readyUnits(justActedTeam).length;
    if (!readyOther && !readyCur) { nextTurningPoint(); return; }
    let counteractTeam = null;
    if (readyOther) {
      state.combat.activeTeam = other;
      if (!readyCur) counteractTeam = justActedTeam;
    } else {
      state.combat.activeTeam = justActedTeam;
      counteractTeam = other;
    }
    if (counteractTeam && counteractCandidates(counteractTeam).length) {
      state.combat.counteract = { team: counteractTeam, selecting: true };
    } else {
      state.combat.counteract = null;
    }
    state.combat.selectedId = readyUnits(state.combat.activeTeam)[0] || null;
    if (checkVictory()) return;
    syncActivationPanel();
    render();
  }

  // ── Counteract ─────────────────────────────────────────────────────
  // An expended operative with an Engage order may perform one free 1AP
  // action (excluding Guard) between enemy activations, once per turning
  // point, moving no more than 2".
  function counteractCandidates(team) {
    return state.units.filter(u => u.alive && u.deployed && u.team === team
      && u.unitState === 'activated' && u.order === 'engage'
      && !u.hasCounteracted);
  }

  function startCounteract(unit) {
    const c = state.combat.counteract;
    if (!c || unit.team !== c.team) return;
    c.selecting = false;
    state.combat.selectedId = unit;
    state.combat.activation = {
      unit,
      counteract: true,
      order: unit.order,
      ap: 1,
      apMax: 1,
      history: [],
      undoStack: [],
      hasReposition: false, hasDashed: false, hasCharged: false,
      hasFallenBack: false, hasShot: false, hasFought: false,
      hasGuard: false, teleportedThisActivation: false,
      baseline: null,
    };
    state.combat.activation.baseline = snapshotForUndo();
    log(`${teamName(unit.team)} counteracts with ${unit.letter} (${unit._displayName}).`, 'turn');
    syncActivationPanel();
    render();
  }

  function passCounteract() {
    const c = state.combat.counteract;
    if (!c) return;
    log(`${teamName(c.team)} passes on counteracting.`);
    state.combat.counteract = null;
    syncActivationPanel();
    render();
  }

  function endCounteract() {
    const a = activation();
    if (!a || !a.counteract) return;
    a.unit.hasCounteracted = true;
    log(`${a.unit.letter} finishes counteracting.`, 'turn');
    state.combat.activation = null;
    state.combat.pendingMove = null;
    state.combat.counteract = null;
    state.combat.selectedId = readyUnits(state.combat.activeTeam)[0] || null;
    if (checkVictory()) return;
    syncActivationPanel();
    render();
  }

  // Counteract allows exactly one action — auto-finish once AP is spent.
  function maybeFinishCounteract() {
    const a = activation();
    if (a && a.counteract && a.ap <= 0) endCounteract();
  }

  function nextTurningPoint() {
    // Score the round that just ended before advancing the turning point.
    scoreEndOfTurningPoint();
    // The game always ends after the final turning point — most VP wins.
    if (state.combat.turningPoint >= RC.MAX_TURNING_POINTS) {
      endGameByScore();
      return;
    }
    state.combat.turningPoint++;
    const tp = state.combat.turningPoint;
    log(`— Turning Point ${tp} begins —`, 'turn');
    // Strategy phase: roll off for initiative. A tie goes to the player who
    // did NOT have initiative (Approved Ops rule — no re-roll).
    const ia = KTR.rollD6(), ib = KTR.rollD6();
    let initiative;
    if (ia === ib) {
      initiative = state.combat.initiativeTeam === 'A' ? 'B' : 'A';
      log(`Initiative roll — tied at ${ia}: ${teamName(initiative)} seizes initiative.`, 'turn');
    } else {
      initiative = ia > ib ? 'A' : 'B';
      log(`Initiative roll — Blue ${ia} vs Red ${ib}: ${teamName(initiative)} takes initiative.`, 'turn');
    }
    state.combat.initiativeTeam = initiative;
    state.combat.activeTeam = initiative;
    // Ready step: 1CP each, but the player without initiative gains 2CP.
    const noInit = initiative === 'A' ? 'B' : 'A';
    state.combat.cp[initiative] += RC.CP_PER_TP;
    state.combat.cp[noInit] += RC.CP_PER_TP * 2;
    log(`Command Points — ${teamName('A')} ${state.combat.cp.A}CP · ${teamName('B')} ${state.combat.cp.B}CP.`);
    state.units.forEach(u => {
      if (u.alive) {
        u.unitState = 'ready'; u.order = null; u.ap = u.apl;
        u.onGuard = false; u.hasCounteracted = false;
      }
    });
    state.combat.counteract = null;
    state.combat.usedPloys = { A: new Set(), B: new Set() };
    state.combat.activePloys = { A: [], B: [] };
    selectEnvoys();
    state.combat.selectedId = readyUnits(state.combat.activeTeam)[0] || null;
    if (checkVictory()) return;
    syncActivationPanel();
    render();
  }

  // Game end after the final turning point: highest VP wins (a draw is
  // possible and reported as such).
  function endGameByScore() {
    state.combat.over = true;
    state.phase = 'over';
    state.combat.activation = null;
    state.combat.pendingMove = null;
    // Kill Op end-of-battle bonus: higher kill grade than the opponent = 1VP.
    if (state.score.killOp.A !== state.score.killOp.B) {
      const higher = state.score.killOp.A > state.score.killOp.B ? 'A' : 'B';
      state.score.killOp[higher] += 1;
      log(`${teamName(higher)} scores 1VP (higher kill grade).`, 'turn');
    }
    const aVP = totalVP('A'), bVP = totalVP('B');
    let title, text;
    if (aVP === bVP) {
      title = 'Stalemate';
      text = `Four turning points fought to a standstill. Final VP — Blue ${aVP} · Red ${bVP}.`;
    } else {
      const winner = aVP > bVP ? 'A' : 'B';
      title = `${teamName(winner)} Victorious`;
      text = `The mission concludes after Turning Point ${RC.MAX_TURNING_POINTS}. Final VP — Blue ${aVP} · Red ${bVP}.`;
    }
    overlayTitle.textContent = title;
    overlayText.textContent = text;
    overlay.style.display = 'flex';
    syncActivationPanel();
    render();
  }

  function checkVictory() {
    const aAlive = state.units.some(u => u.team === 'A' && u.alive);
    const bAlive = state.units.some(u => u.team === 'B' && u.alive);
    if (aAlive && bAlive) return false;
    // Score crit op for the in-progress round before the game closes out.
    scoreEndOfTurningPoint();
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
    // Each straight-line increment is rounded UP to the nearest inch.
    const segDist = Math.ceil(Math.hypot(toX - last.x, toY - last.y) - 1e-6);
    if (pm.used + segDist > pm.maxInches + 1e-3) {
      return `Beyond move budget (${(pm.used + segDist).toFixed(0)}" > ${pm.maxInches.toFixed(0)}" — each leg rounds up).`;
    }
    // The whole base must clear the wall along the leg, not just the centre
    // line — segment-to-segment distance from the path to every wall must be
    // at least the operative's base radius.
    if (KTR.moveBlockedByWalls(mapDef, state.combat.pieceState.open, last.x, last.y, toX, toY, r)) {
      return 'Base clips a wall along this leg.';
    }
    if (unitOccupiesCircle(toX, toY, r, u)) return 'Waypoint occupied.';
    // Enemy control range along the leg — measured base-edge to base-edge.
    if (pm.kind === 'reposition' || pm.kind === 'dash') {
      for (const e of pathEnemyList(u)) {
        const enemyR = KTR.unitBaseRadius(e);
        const reach = RC.ENGAGEMENT_RANGE + r + enemyR;
        const d = KTR.pointSegDist(e.x, e.y, last.x, last.y, toX, toY);
        if (d < reach - 1e-3) {
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
    const r = unitRadiusMax(u);
    const inCR = enemies.some(e => {
      const reach = RC.ENGAGEMENT_RANGE + r + KTR.unitBaseRadius(e);
      return Math.hypot(e.x - last.x, e.y - last.y) <= reach + 1e-3;
    });
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
    pm.used += Math.ceil(Math.hypot(x - last.x, y - last.y) - 1e-6);
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
    pm.used = Math.max(0, pm.used - Math.ceil(Math.hypot(last.x - prev.x, last.y - prev.y) - 1e-6));
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
    // Any action performed while on guard ends the guard stance.
    u.onGuard = false;
    const legs = pm.waypoints.length - 1;
    a.history.push({ type: pm.kind, dist: pm.used, legs });
    log(`${u.letter} ${label} ${pm.used.toFixed(1)}"${legs > 1 ? ` (${legs} legs)` : ''}.`);
    state.combat.pendingMove = null;
    activationHint.classList.remove('warn');
    activationHint.textContent = '';
    afterActionResolved();
  }

  // Common post-action hook: offers Guard interrupts to the opposing side,
  // then finishes a counteract if its single action was just spent.
  function afterActionResolved() {
    maybeOfferGuardInterrupt();
    maybeFinishCounteract();
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
    u.onGuard = false;
    log(`${u.letter} teleports across the pads.`);
    state.combat.pendingMove = null;
    afterActionResolved();
  }

  function padAt(x, y) {
    const pads = mapDef.teleporters || [];
    return pads.find(p => Math.hypot(p.x - x, p.y - y) <= (p.r || 1.0)) || null;
  }
  function otherPads(currentPad) {
    return (mapDef.teleporters || []).filter(p => !currentPad || p.pieceIndex !== currentPad.pieceIndex);
  }

  // ── Hatchway / breach actions ──────────────────────────────────────
  // Distance is measured from the operative to the closest point on the
  // wall *segment*, not to its midpoint. Hatchways can be up to 8" long,
  // so a midpoint check would put a unit standing right next to the wall
  // outside the 1" interaction range as soon as the wall is more than 2"
  // long. Falls back to the stored midpoint if we can't find the segment.
  function pointSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function openableDistance(o, u) {
    // Reach to a hatch/breach is measured base-edge to closest point on the
    // openable span — never to the midpoint of the wall (which can be far if
    // the wall is long).
    const w = (mapDef.walls || []).find(w => w.pieceIndex === o.pieceIndex);
    const base = w
      ? pointSegDist(u.x, u.y, w.x1, w.y1, w.x2, w.y2)
      : Math.hypot(o.x - u.x, o.y - u.y);
    return Math.max(0, base - KTR.unitBaseRadius(u));
  }
  function nearestOpenable(u, kindFilter) {
    const list = mapDef.openable || [];
    let best = null, bestD = Infinity;
    for (const o of list) {
      if (kindFilter && o.kind !== kindFilter) continue;
      const d = openableDistance(o, u);
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best || bestD > RC.ENGAGEMENT_RANGE + 1e-3) return null;
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
    u.onGuard = false;
    a.history.push({ type: 'operateHatch', piece: target.pieceIndex, open: !wasOpen });
    log(`${u.letter} ${wasOpen ? 'closes' : 'opens'} hatchway ${target.label || ''}.`);
    afterActionResolved();
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
    u.onGuard = false;
    a.history.push({ type: 'breach', piece: target.pieceIndex });
    log(`${u.letter} breaches the wall ${target.label || ''} (${cost} AP).`);
    // Concussion: each operative on the far side within control range of the
    // access point rolls a D6 — on 4+ it loses 1 APL and takes half the
    // result (rounded up) in damage.
    breachConcussion(target, u);
    afterActionResolved();
  }

  function breachConcussion(target, breacher) {
    for (const o of state.units) {
      if (!o.alive || !o.deployed || o === breacher) continue;
      const w = (mapDef.walls || []).find(w => w.pieceIndex === target.pieceIndex);
      const d = w
        ? pointSegDist(o.x, o.y, w.x1, w.y1, w.x2, w.y2) - KTR.unitBaseRadius(o)
        : Math.hypot(target.x - o.x, target.y - o.y) - KTR.unitBaseRadius(o);
      if (d > RC.ENGAGEMENT_RANGE + 1e-3) continue;
      // Same side as the breacher? Concussion hits the operatives on the
      // OTHER side. Use the wall segment as the divider.
      if (w) {
        const sideOf = (x, y) => Math.sign((w.x2 - w.x1) * (y - w.y1) - (w.y2 - w.y1) * (x - w.x1)) || 1;
        if (sideOf(o.x, o.y) === sideOf(breacher.x, breacher.y)) continue;
      }
      const roll = KTR.rollD6();
      if (roll >= 4) {
        const dmg = Math.ceil(roll / 2);
        o.aplMod = -1;
        o.hp = Math.max(0, o.hp - dmg);
        log(`Breach concussion: ${o.letter} takes ${dmg} damage and -1 APL (rolled ${roll}).`, 'hit');
        if (o.hp <= 0) {
          o.alive = false;
          o.unitState = 'incapacitated';
          log(`${o.letter} (${o._displayName}) is incapacitated by the breach.`, 'kill');
          registerKill(breacher.team, breacher, o);
        }
      } else {
        log(`Breach concussion: ${o.letter} shrugs it off (rolled ${roll}).`);
      }
    }
  }

  // ── Mission actions (crit op + tac op) ──────────────────────────────
  function contestedControlledObjectives(u) {
    const out = [];
    (mapDef.objectives || []).forEach((obj, i) => {
      if (unitContests(u, obj) && objectiveControl(obj) === u.team) out.push(i);
    });
    return out;
  }

  function scoutTargets(u) {
    return state.units.filter(e => e.alive && e.deployed && e.team !== u.team
      && e.unitState === 'ready'
      && KTR.edgeDist(u, e) > 6
      && KTR.shootEnv(mapDef, state.combat.pieceState.open, u, e).visible);
  }

  function missionActionsFor(u, a) {
    const ops = opsState();
    if (!ops) return [];
    const tp = state.combat.turningPoint;
    if (tp < 2) return [];
    if (KTR.inEnemyControlRange(u, state.units)) return [];
    const out = [];
    const objIdxs = contestedControlledObjectives(u);
    const apShort = a.ap < 1 ? 'Not enough AP.' : null;
    if (objIdxs.length) {
      if (ops.critOp === 'secure') {
        const i = objIdxs.find(ix => ops.objState[ix].securedBy !== u.team);
        if (i != null) out.push({ id: 'ma-secure', name: 'Secure', cost: 1, info: 'Hold until enemy re-secures', reason: apShort, obj: i });
      } else if (ops.critOp === 'loot') {
        const i = objIdxs.find(ix => ops.objState[ix].lootedTP < tp);
        if (i != null) {
          const capped = ops.lootVPThisTP[u.team] >= 2;
          out.push({ id: 'ma-loot', name: 'Loot', cost: 1, info: '+1VP', reason: apShort || (capped ? 'Already scored 2VP this turning point.' : null), obj: i });
        }
      } else if (ops.critOp === 'transmission') {
        const i = objIdxs.find(ix => !ops.objState[ix].transmitting);
        if (i != null) out.push({ id: 'ma-transmit', name: 'Initiate Transmission', cost: 1, info: 'Transmits until next TP', reason: apShort, obj: i });
      }
    }
    const to = ops.tacOps[u.team];
    if (to) {
      if (to.id === 'plant-devices') {
        const i = objIdxs.find(ix => !to.deviceTokens[ix]);
        if (i != null) out.push({ id: 'ma-plant', name: 'Plant Device', cost: 1, info: 'Rig this objective', reason: apShort, obj: i });
      } else if (to.id === 'scout' && u.order === 'conceal' && scoutTargets(u).length) {
        out.push({ id: 'ma-scout', name: 'Scout', cost: 1, info: 'Monitor a distant enemy', reason: apShort });
      }
    }
    return out;
  }

  function performMissionAction(item) {
    const a = activation();
    if (!a || a.ap < 1) return;
    const ops = opsState();
    const u = a.unit;
    if (item.id === 'ma-scout') {
      const targets = scoutTargets(u);
      if (!targets.length) return;
      const items = targets.map(t => ({
        letter: t.letter, name: t._displayName,
        meta: `${KTR.edgeDist(u, t).toFixed(1)}"`,
        color: TEAM_INFO[t.team].color,
        onPick: () => {
          clearTargetPicker();
          pushUndo();
          a.ap -= 1;
          u.onGuard = false;
          const to = ops.tacOps[u.team];
          to.monitored.add(state.units.indexOf(t));
          a.history.push({ type: 'scout', target: t.letter });
          log(`${u.letter} scouts ${t.letter} — monitored this turning point.`);
          afterActionResolved();
        },
      }));
      showTargetPickerAt(items, { title: 'Scout — pick an enemy to monitor' });
      return;
    }
    pushUndo();
    a.ap -= 1;
    u.onGuard = false;
    const i = item.obj;
    if (item.id === 'ma-secure') {
      ops.objState[i].securedBy = u.team;
      a.history.push({ type: 'secure', obj: i });
      log(`${u.letter} secures objective ${i + 1}.`, 'turn');
    } else if (item.id === 'ma-loot') {
      ops.objState[i].lootedTP = state.combat.turningPoint;
      ops.lootVPThisTP[u.team] += 1;
      a.history.push({ type: 'loot', obj: i });
      addCritVP(u.team, 1, 'Loot');
    } else if (item.id === 'ma-transmit') {
      ops.objState[i].transmitting = true;
      a.history.push({ type: 'transmit', obj: i });
      log(`${u.letter} sets objective ${i + 1} transmitting.`, 'turn');
    } else if (item.id === 'ma-plant') {
      ops.tacOps[u.team].deviceTokens[i] = true;
      a.history.push({ type: 'plantDevice', obj: i });
      log(`${u.letter} plants a device on objective ${i + 1}.`, 'turn');
    }
    afterActionResolved();
  }

  // ── Guard ──────────────────────────────────────────────────────────
  function performGuard() {
    const a = activation();
    if (!a) return;
    const u = a.unit;
    const reason = KTR.validate.guard(u, a, state.units);
    if (reason) { activationHint.textContent = reason; activationHint.classList.add('warn'); return; }
    pushUndo();
    a.ap -= RC.GUARD_AP;
    a.hasGuard = true;
    u.onGuard = true;
    a.history.push({ type: 'guard' });
    log(`${u.letter} goes on Guard.`);
    syncActivationPanel();
    render();
  }

  // After an enemy action resolves, an opposing operative on guard may
  // interrupt with a free Shoot or Fight (once per enemy activation).
  function maybeOfferGuardInterrupt() {
    const a = activation();
    if (!a || a.counteract || a.guardInterrupted) return;
    if (!a.unit || !a.unit.alive) return;
    const enemyTeam = a.unit.team === 'A' ? 'B' : 'A';
    const options = [];
    for (const g of state.units) {
      if (!g.alive || !g.deployed || g.team !== enemyTeam || !g.onGuard) continue;
      const canShoot = !KTR.inEnemyControlRange(g, state.units) && shootCandidates(g).length > 0;
      const canFight = fightCandidates(g).length > 0
        && (g.weapons || []).some(w => w.is_melee);
      if (canShoot) options.push({ unit: g, kind: 'shoot' });
      if (canFight) options.push({ unit: g, kind: 'fight' });
    }
    if (!options.length) return;
    const items = options.map(o => ({
      letter: o.unit.letter,
      name: `${o.unit._displayName} — ${o.kind === 'shoot' ? 'Shoot' : 'Fight'} (free)`,
      meta: 'Guard interrupt',
      color: TEAM_INFO[o.unit.team].color,
      onPick: () => {
        clearTargetPicker();
        a.guardInterrupted = true;
        o.unit.onGuard = false;
        log(`${o.unit.letter} interrupts on Guard!`, 'turn');
        if (o.kind === 'shoot') openGuardShoot(o.unit);
        else openGuardFight(o.unit);
      },
    }));
    showTargetPickerAt(items, { title: `${teamName(enemyTeam)} — Guard interrupt?` });
  }

  function openGuardShoot(guardUnit) {
    const cands = shootCandidates(guardUnit);
    if (!cands.length) return;
    const items = cands.map(c => ({
      letter: c.target.letter,
      name: c.target._displayName,
      meta: `${KTR.edgeDist(guardUnit, c.target).toFixed(1)}" · HP ${c.target.hp}/${c.target.maxHp}`,
      color: TEAM_INFO[c.target.team].color,
      onPick: () => {
        clearTargetPicker();
        openShootModal(guardUnit, c.target, c.env);
        if (state.combat.shoot) state.combat.shoot.free = true;
      },
    }));
    showTargetPickerAt(items, { title: 'Guard — pick target' });
  }

  function openGuardFight(guardUnit) {
    const cands = fightCandidates(guardUnit);
    if (!cands.length) return;
    const pick = (t) => {
      clearTargetPicker();
      openFightModal(guardUnit, t);
      if (state.combat.fight) state.combat.fight.free = true;
    };
    if (cands.length === 1) { pick(cands[0]); return; }
    const items = cands.map(t => ({
      letter: t.letter, name: t._displayName,
      meta: `HP ${t.hp}/${t.maxHp}`,
      color: TEAM_INFO[t.team].color,
      onPick: () => pick(t),
    }));
    showTargetPickerAt(items, { title: 'Guard — pick target' });
  }

  // ── Activation panel ────────────────────────────────────────────────
  let lastActivationUnit = null;
  function syncActivationPanel() {
    if (state.phase !== 'combat' || state.combat.over) {
      activationPanel.style.display = 'none';
      document.body.classList.remove('has-activation-dock', 'dock-collapsed', 'dock-orders');
      activationPanel.classList.remove('collapsed');
      document.body.style.removeProperty('--dock-h');
      syncMiniHud(null);
      return;
    }
    activationPanel.style.display = '';
    document.body.classList.add('has-activation-dock');
    const a = activation();

    // When the active unit changes, reset disclosure state so each new
    // activation starts with the primary actions visible and the dock
    // expanded. (We don't auto-collapse mid-activation.)
    const unitNow = a ? a.unit : null;
    if (unitNow !== lastActivationUnit) {
      lastActivationUnit = unitNow;
      moreActionsOpen = false;
      applyMoreActionsOpen();
      activationPanel.classList.remove('collapsed');
      document.body.classList.remove('dock-collapsed');
    }

    if (!a) {
      // Counteract offer takes over the dock until resolved or passed.
      const c = state.combat.counteract;
      if (c && c.selecting) {
        const cands = counteractCandidates(c.team);
        activationWho.textContent = `${teamName(c.team)} — Counteract?`;
        activationMeta.textContent = `${cands.length} eligible · free 1AP action · TP ${state.combat.turningPoint}`;
        activationOrders.style.display = 'none';
        activationActions.style.display = '';
        actionGrid.innerHTML = '';
        if (actionGridMore) actionGridMore.innerHTML = '';
        if (actionMoreToggle) actionMoreToggle.style.display = 'none';
        cands.forEach(u2 => {
          actionGrid.appendChild(buildActionButton(
            { id: 'ca', name: `${u2.letter} · ${u2._displayName}`, cost: '·', info: `HP ${u2.hp}/${u2.maxHp}`, reason: null },
            () => startCounteract(u2)
          ));
        });
        actionGrid.appendChild(buildActionButton(
          { id: 'pass', name: 'Pass', cost: '·', info: 'Skip counteracting', reason: null },
          passCounteract
        ));
        activationHint.classList.remove('warn');
        activationHint.textContent = 'An expended Engage operative may perform one free 1AP action (max 2" move), once per turning point.';
        document.body.classList.remove('dock-orders');
        syncMiniHud(null);
        undoBtn.disabled = true;
        return;
      }
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
      document.body.classList.remove('dock-orders');
      syncMiniHud(null);
      return;
    }
    const u = a.unit;
    activationWho.textContent = `${u.letter} · ${u._displayName}`;
    const orderLocked = a.history.length > 0;
    const orderChip = renderOrderChip(a.order, orderLocked);
    activationMeta.innerHTML = `AP ${a.ap}/${a.apMax} · ${orderChip} · TP ${state.combat.turningPoint}`;
    wireOrderChip();
    syncMiniHud(a);
    document.body.classList.remove('dock-orders');
    activationOrders.style.display = 'none';
    activationActions.style.display = '';
    renderActionGrid();
    const pm = state.combat.pendingMove;
    if (pm) {
      const remaining = Math.max(0, pm.maxInches - pm.used);
      const legs = pm.waypoints.length - 1;
      if (!activationHint.classList.contains('warn')) {
        const base = legs === 0
          ? `${pm.label}: tap on the board to set waypoints. Budget ${pm.maxInches.toFixed(1)}".`
          : `${pm.label}: ${pm.used.toFixed(1)}" used · ${remaining.toFixed(1)}" left · ${legs} leg${legs === 1 ? '' : 's'}. Add more waypoints to route around walls/CR; press Confirm to commit.`;
        activationHint.innerHTML = escapeHtml(base) + kbdHintHTML('move');
      }
    } else if (!a.history.length) {
      activationHint.classList.remove('warn');
      activationHint.innerHTML = 'Choose an action. Press Undo to revert any choice until you End Activation.' + kbdHintHTML('actions');
    } else {
      activationHint.classList.remove('warn');
      activationHint.innerHTML = '' + kbdHintHTML('actions');
    }
    undoBtn.disabled = a.undoStack.length === 0;
  }

  function kbdHintHTML(ctx) {
    if (ctx === 'move') {
      return `<span class="kbd-hint"><kbd>Enter</kbd> confirm · <kbd>Backspace</kbd> undo leg · <kbd>Esc</kbd> cancel</span>`;
    }
    return `<span class="kbd-hint"><kbd>1</kbd>–<kbd>6</kbd> action · <kbd>E</kbd>/<kbd>C</kbd> order · <kbd>U</kbd> undo · <kbd>Space</kbd> end</span>`;
  }

  function buildActionButton(it, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-btn';
    const reason = it.reason;
    btn.disabled = !!reason;
    const costHtml = it.cost === '·'
      ? `<span class="ab-cost">${escapeHtml(it.info)}</span>`
      : `<span class="ab-cost"><strong>${it.cost} AP</strong> · ${escapeHtml(it.info)}</span>`;
    btn.innerHTML = `
      <span class="ab-name">${escapeHtml(it.name)}</span>
      ${costHtml}
      ${reason ? `<span class="ab-reason">${escapeHtml(reason)}</span>` : ''}
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderActionGrid() {
    actionGrid.innerHTML = '';
    if (actionGridMore) actionGridMore.innerHTML = '';
    if (actionMoreToggle) actionMoreToggle.style.display = 'none';
    const a = activation();
    if (!a) return;
    const u = a.unit;
    const pm = state.combat.pendingMove;

    // While a move is being plotted, swap the grid for path controls so the
    // user is funnelled toward Confirm / Undo Waypoint / Cancel. The "More"
    // tray stays empty during this phase.
    if (pm) {
      const legs = pm.waypoints.length - 1;
      const endpointBlocked = legs > 0 ? endpointReason(u, pm) : null;
      const items = [
        { id: '_confirm',  name: 'Confirm Move', info: legs ? `Spend ${pm.used.toFixed(1)}" / ${pm.maxInches.toFixed(1)}"` : 'Add a waypoint first', cost: actionAPCost(pm.kind, u), reason: legs ? endpointBlocked : 'Tap on the board to set a waypoint.' },
        { id: '_undo_wp',  name: 'Undo Waypoint', info: legs ? `Remove last leg` : 'No legs yet', cost: '·', reason: legs ? null : 'No waypoints to undo.' },
        { id: '_cancel',   name: 'Cancel Move', info: 'Disarm this action', cost: '·', reason: null },
      ];
      for (const it of items) {
        const btn = buildActionButton(it, () => {
          if (it.id === '_confirm') commitPath();
          else if (it.id === '_undo_wp') undoWaypoint();
          else if (it.id === '_cancel') cancelPath();
        });
        if (it.id === '_confirm' && !it.reason) btn.classList.add('armed');
        actionGrid.appendChild(btn);
      }
      return;
    }

    const v = KTR.validate;
    const hatchAvailable = !!nearestOpenable(u, 'hatchway');
    const breachAvailable = !!nearestOpenable(u, 'breach');
    // Primary actions are the four every operative considers most turns:
    // a movement choice, plus their attacks. We always show these, even if
    // they're not legal right now, so the player gets feedback on *why*
    // they can't (e.g. "out of AP", "no enemy in range").
    const effMove = KTR.effectiveMove(u);
    const injuredTag = KTR.isInjured(u) ? ' (injured)' : '';
    const primary = [
      { id: 'reposition', name: 'Reposition', cost: RC.REPOSITION_AP, info: `Move ${effMove}"${injuredTag}`, reason: v.reposition(u, a) },
      { id: 'dash',       name: 'Dash',       cost: RC.DASH_AP,        info: `Move ${RC.DASH_INCHES}"`,                  reason: v.dash(u, a) },
      { id: 'shoot',      name: 'Shoot',      cost: RC.SHOOT_AP,       info: 'Ranged attack',                             reason: v.shoot(u, a, state.units) },
      { id: 'fight',      name: 'Fight',      cost: RC.FIGHT_AP,       info: 'Melee attack',                              reason: v.fight(u, a, state.units) },
    ];
    // Secondary actions: charge/fall back are situational; hatchway/breach
    // are entirely irrelevant unless one is nearby. Filter the latter out
    // completely instead of greying them out — there's no "fix" that turns
    // a missing hatchway into a present one.
    const secondary = [
      { id: 'charge',    name: 'Charge',     cost: RC.CHARGE_AP,    info: `Move ${effMove + RC.CHARGE_BONUS}", end in CR`, reason: v.charge(u, a, state.units) },
      { id: 'fallBack',  name: 'Fall Back',  cost: RC.FALL_BACK_AP, info: `Move ${effMove}"`,                              reason: v.fallBack(u, a, state.units) },
      { id: 'guard',     name: 'Guard',      cost: RC.GUARD_AP,     info: 'Interrupt later with a free Shoot/Fight',       reason: v.guard(u, a, state.units) },
    ];
    if (hatchAvailable) secondary.push({ id: 'openHatch', name: 'Operate Hatch', cost: RC.OPEN_HATCH_AP, info: 'Open / close', reason: v.openHatchway(u, a) });
    if (breachAvailable) secondary.push({ id: 'breach', name: 'Breach', cost: KTR.breachAPCost(u), info: 'Open a breach point', reason: v.breach(u, a) });
    // Mission actions (crit op / tac op) surface only when performable here.
    for (const ma of missionActionsFor(u, a)) secondary.push(ma);
    // Counteract: a single free 1AP action, moving no more than 2"; Guard
    // and Fall Back are excluded.
    if (a.counteract) {
      const moveNote = ' (max 2")';
      primary.forEach(it => {
        if (it.id === 'reposition' || it.id === 'dash') it.info += moveNote;
      });
      for (let i = secondary.length - 1; i >= 0; i--) {
        if (secondary[i].id === 'guard' || secondary[i].id === 'fallBack') secondary.splice(i, 1);
        else if (secondary[i].id === 'charge') secondary[i].info = 'Move 2", end in CR';
        else if (secondary[i].id === 'breach' && KTR.breachAPCost(u) > 1) secondary.splice(i, 1);
      }
    }

    // Promote any secondary action that's currently legal to the primary
    // grid so the most relevant choice for *this* situation is always one
    // tap away. (e.g. if the unit is in CR, Fall Back jumps to primary.)
    const promoted = [];
    for (let i = secondary.length - 1; i >= 0; i--) {
      if (!secondary[i].reason) {
        promoted.unshift(secondary[i]);
        secondary.splice(i, 1);
      }
    }
    const primaryRendered = primary.concat(promoted);

    for (const it of primaryRendered) {
      actionGrid.appendChild(buildActionButton(it, () => onActionClick(it.id, it)));
    }
    if (actionGridMore && secondary.length) {
      for (const it of secondary) {
        actionGridMore.appendChild(buildActionButton(it, () => onActionClick(it.id, it)));
      }
      if (actionMoreToggle) {
        actionMoreToggle.style.display = '';
        applyMoreActionsOpen();
      }
    }
  }

  // ── Mini-HUD on canvas (combat) ──────────────────────────────────────
  // Mirrors the active operative summary onto a small overlay anchored to
  // the top-left of the board, so phone players can see whose turn / AP /
  // order without scrolling to the bottom dock.
  function syncMiniHud(a) {
    if (!miniHud) return;
    if (!a || state.phase !== 'combat' || state.combat.over) {
      miniHud.style.display = 'none';
      return;
    }
    const u = a.unit;
    miniHud.style.display = '';
    miniHudLetter.textContent = u.letter;
    miniHudLetter.dataset.team = u.team;
    miniHudName.textContent = u._displayName;
    const pips = '●'.repeat(a.ap) + '○'.repeat(Math.max(0, a.apMax - a.ap));
    miniHudAp.innerHTML = `<span class="mh-ap-pips">${pips}</span>`;
    miniHudOrder.className = 'mh-order' + (a.order ? ' ' + a.order : '');
    miniHudOrder.textContent = a.order ? (a.order === 'engage' ? 'ENGAGE' : 'CONCEAL') : '— no order';
    miniHudHp.textContent = `HP ${u.hp}/${u.maxHp}`;
  }

  function actionAPCost(kind, unit) {
    if (kind === 'reposition') return RC.REPOSITION_AP;
    if (kind === 'dash') return RC.DASH_AP;
    if (kind === 'charge') return RC.CHARGE_AP;
    if (kind === 'fallBack') return RC.FALL_BACK_AP;
    return 1;
  }

  function onActionClick(id, item) {
    const a = activation();
    if (!a) return;
    activationHint.classList.remove('warn');
    activationHint.textContent = '';
    if (id.startsWith('ma-')) { performMissionAction(item); return; }
    if (id === 'reposition' || id === 'dash' || id === 'charge' || id === 'fallBack') {
      const u = a.unit;
      const moveIn = KTR.effectiveMove(u);
      let max =
        id === 'reposition' ? moveIn :
        id === 'dash' ? RC.DASH_INCHES :
        id === 'charge' ? moveIn + RC.CHARGE_BONUS :
        moveIn;
      // Counteracting operatives cannot move more than 2".
      if (a.counteract) max = Math.min(max, 2);
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
    if (id === 'guard') { performGuard(); return; }
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
  // Weapon range is measured base-edge to base-edge. A weapon can be used
  // against a target only if the target is within its Range (∞ if none).
  function weaponReaches(attacker, weapon, target) {
    return KTR.edgeDist(attacker, target) <= KTR.weaponRange(weapon) + 1e-3;
  }
  function rangedWeaponsInRange(attacker, target) {
    return (attacker.weapons || []).filter(w => !w.is_melee && weaponReaches(attacker, w, target));
  }
  function hasSilentRanged(unit) {
    return (unit.weapons || []).some(w => {
      if (w.is_melee) return false;
      const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
      return KTR.hasRule(parsed, 'Silent');
    });
  }
  function shootCandidates(attacker, opts) {
    const out = [];
    const concealShooter = attacker.order === 'conceal';
    for (const o of state.units) {
      if (!o.alive || !o.deployed || o.team === attacker.team) continue;
      const env = KTR.shootEnv(mapDef, state.combat.pieceState.open, attacker, o);
      if (!env.visible) continue;
      // Conceal target in cover is not a valid target.
      if (o.order === 'conceal' && env.inCover) continue;
      // Cannot shoot an enemy that has friendly operatives within its
      // control range (no shooting into your own melee).
      const friendlyEngaged = state.units.some(fr =>
        fr !== attacker && fr.alive && fr.deployed && fr.team === attacker.team
        && KTR.edgeDist(fr, o) <= RC.ENGAGEMENT_RANGE + 1e-3);
      if (friendlyEngaged) continue;
      // A concealed shooter may only use Silent weapons.
      const pool = rangedWeaponsInRange(attacker, o).filter(w => {
        if (!concealShooter) return true;
        const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
        return KTR.hasRule(parsed, 'Silent');
      });
      if (!pool.length) continue;
      out.push({ target: o, env, weapons: pool });
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
    let ranged = rangedWeaponsInRange(attacker, target);
    if (attacker.order === 'conceal') {
      ranged = ranged.filter(w => {
        const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
        return KTR.hasRule(parsed, 'Silent');
      });
    }
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
    // Fast-path: if the attacker has exactly one ranged weapon, the player has
    // already committed to "shoot this target with this weapon" by the time
    // the modal opens — roll attack + defence and auto-allocate optimally so
    // the dialog opens to the resolved result. The "Re-roll" and "Allocate
    // manually" controls remain for fine-grained control. With multiple
    // weapons we still pause on the weapon picker.
    if (ranged.length === 1) {
      autoResolveShoot();
    }
    renderShootModal();
  }

  function autoResolveShoot() {
    const s = state.combat.shoot;
    if (!s) return;
    rollShootAttack(true);
    rollShootDefence(true);
    allocateShootSavesOptimally();
    s.step = 'resolved';
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
    const dice = KTR.defenceDiceCount(parsed, inCover, !!(s.atk && s.atk.counts.c > 0));
    const rangeStr = KTR.rangeFromInches(w);
    let html = `
      <div class="kt-side-row">
        <div class="kt-side">
          <h3>Shooter</h3>
          <div class="kt-side-meta">
            <strong>${s.attacker.letter} · ${escapeHtml(s.attacker._displayName)}</strong><br>
            Atk ${w.atk} · Hit ${w.hit}+ · Dmg ${w.normal_dmg}/${w.crit_dmg}<br>
            ${escapeHtml(w.name)}${(() => {
              // Drop "Range N\"" from the rules join — the dedicated Range line
              // below already shows it (and renders ∞ for unlimited weapons).
              const extras = (w.rules || []).filter(r => !/^Range\b/i.test(String(r)));
              return extras.length ? ' · ' + escapeHtml(extras.join(' · ')) : '';
            })()}<br>
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

    // Weapon picker (only if multiple ranged weapons exist). Weapons whose
    // Range can't reach the chosen target render disabled.
    const ranged = (s.attacker.weapons || []).filter(x => !x.is_melee);
    if (ranged.length > 1) {
      html += `<span class="kt-step-tag">Step 1 · Weapon</span><div class="kt-weapon-pick" id="kt-weapon-pick">`;
      for (let i = 0; i < ranged.length; i++) {
        const r = ranged[i];
        const reaches = weaponReaches(s.attacker, r, s.target);
        html += `<div class="kt-weapon-row${r === s.weapon ? ' selected' : ''}${reaches ? '' : ' disabled'}" data-i="${i}"${reaches ? '' : ' aria-disabled="true"'}>
          <span class="kt-w-name">${escapeHtml(r.name)}</span>
          <span class="kt-w-stats">A${r.atk} · ${r.hit}+ · ${r.normal_dmg}/${r.crit_dmg}${r.rules && r.rules.length ? ' · ' + escapeHtml(r.rules.join(', ')) : ''}${reaches ? '' : ' · OUT OF RANGE'}</span>
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
          const willKill = s.target.hp - s.damage <= 0;
          html += `<div class="kt-resolved">
            ${s.target.letter} takes <strong>${s.damage}</strong> damage (${s.atkRemaining.normals} normal × ${w.normal_dmg} + ${s.atkRemaining.criticals} crit × ${w.crit_dmg}${s.devDamage ? ` + ${s.devDamage} Devastating` : ''}).
            ${willKill ? '<br><strong>Will be incapacitated.</strong>' : `<br>HP ${s.target.hp}/${s.target.maxHp} → ${Math.max(0, s.target.hp - s.damage)}/${s.target.maxHp}.`}
          </div>
          <div class="kt-modal-footer">
            ${s.atk && s.atk.fails.length && state.combat.cp[s.attacker.team] > 0
              ? `<button class="btn-ghost" id="kt-cmd-reroll-atk">Shooter: Cmd Re-roll (1CP)</button>` : ''}
            ${s.def && s.def.fails.length && state.combat.cp[s.target.team] > 0
              ? `<button class="btn-ghost" id="kt-cmd-reroll-def">Defender: Cmd Re-roll (1CP)</button>` : ''}
            <button class="btn-ghost" id="kt-shoot-reroll" title="Re-roll attack and defence (Shift+Enter)">Re-roll</button>
            <button class="btn-ghost" id="kt-shoot-manual">Allocate manually</button>
            <button class="btn-fire" id="kt-shoot-done" title="Apply damage (Enter)">Apply damage</button>
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
          if (row.classList.contains('disabled')) return;
          const i = +row.dataset.i;
          s.weapon = ranged[i];
          // Picking a weapon means "this is the one I want to shoot with" —
          // auto-resolve straight to the damage preview, same as the single-
          // weapon fast-path in openShootModal.
          autoResolveShoot();
          renderShootModal();
        });
      });
    }
    const ra = shootBody.querySelector('#kt-roll-attack');
    if (ra) ra.addEventListener('click', () => rollShootAttack(false));
    const rd = shootBody.querySelector('#kt-roll-defence');
    if (rd) rd.addEventListener('click', () => rollShootDefence(false));
    const aa = shootBody.querySelector('#kt-allocate-auto');
    if (aa) aa.addEventListener('click', () => { allocateShootSavesOptimally(); s.step = 'resolved'; renderShootModal(); });
    const am = shootBody.querySelector('#kt-allocate-manual');
    if (am) am.addEventListener('click', () => { s.step = 'allocate'; s.atkRemaining = null; renderShootModal(); attachManualAllocate(); });
    const rs = shootBody.querySelector('#kt-resolve');
    if (rs) rs.addEventListener('click', () => { applyShootResolution(); });
    const reroll = shootBody.querySelector('#kt-shoot-reroll');
    if (reroll) reroll.addEventListener('click', () => { autoResolveShoot(); renderShootModal(); });
    const sm = shootBody.querySelector('#kt-shoot-manual');
    if (sm) sm.addEventListener('click', () => { s.step = 'allocate'; s.atkRemaining = null; renderShootModal(); attachManualAllocate(); });
    const dn = shootBody.querySelector('#kt-shoot-done');
    if (dn) dn.addEventListener('click', commitShoot);
    const cra = shootBody.querySelector('#kt-cmd-reroll-atk');
    if (cra) cra.addEventListener('click', () => commandRerollShoot('atk'));
    const crd = shootBody.querySelector('#kt-cmd-reroll-def');
    if (crd) crd.addEventListener('click', () => commandRerollShoot('def'));

    if (s.step === 'allocate') attachManualAllocate();
  }

  function diceRowHTML(roll, side) {
    if (!roll) return '';
    const cells = [];
    // Pre-retained successes (Accurate / cover save) shown first.
    const auto = roll.autoNormals || 0;
    const autoLabel = side === 'atk' ? 'acc' : 'cover';
    for (let i = 0; i < auto; i++) cells.push(`<div class="kt-dice normal" data-tag="${side}-auto-${i}">A<div class="kt-dice-tag">${autoLabel}</div></div>`);
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

  function rollShootAttack(silent) {
    const s = state.combat.shoot;
    if (!s) return;
    const w = s.weapon;
    const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
    let lethal = KTR.ruleByName(parsed, 'Lethal');
    // Close Quarters (Tomb World killzone): weapons with Blast or Torrent
    // (and distance-based Devastating, which this data set doesn't use)
    // also gain Lethal 5+.
    const cq = KTR.hasRule(parsed, 'Blast') || KTR.hasRule(parsed, 'Torrent');
    if (cq && (!lethal || lethal.value > 5)) lethal = { name: 'Lethal', value: 5, raw: 'Lethal 5+ (Close Quarters)' };
    const critAt = lethal ? lethal.value : 6;
    if (cq) log(`Close Quarters: ${w.name} gains Lethal 5+.`);
    const bs = KTR.effectiveHit(s.attacker, w);

    // Accurate x — retain up to x dice as normal successes without rolling.
    const accurate = KTR.ruleByName(parsed, 'Accurate');
    const retained = accurate ? Math.min(accurate.value, w.atk) : 0;
    const atkDice = w.atk - retained;

    const out = KTR.rollAttack(atkDice, bs, critAt, 0, 0);
    const rolls = out.rolls;
    // Re-roll rules (Balanced / Ceaseless / Relentless) — auto-apply to fails.
    const rerolls = KTR.rerollIndices(parsed, rolls, bs);
    if (rerolls.length) {
      for (const i of rerolls) rolls[i] = KTR.rollD6();
      log(`${s.attacker.letter} re-rolls ${rerolls.length} attack dice (${parsed.find(p => ['Balanced','Ceaseless','Relentless'].includes(p.name)).name}).`);
    }
    const crits = [], normals = [], fails = [];
    for (let i = 0; i < rolls.length; i++) {
      const v = rolls[i];
      if (v >= critAt && v >= bs) crits.push(i);
      else if (v >= bs) normals.push(i);
      else fails.push(i);
    }
    let nN = normals.length + retained, nC = crits.length, nF = fails.length;
    const naturalCrits = crits.length;
    // Severe / Rending / Punishing fixups. Rending and Punishing require a
    // *natural* retained crit — a crit created by Severe doesn't enable them.
    let didFix = '';
    if (KTR.hasRule(parsed, 'Severe') && nC === 0 && nN > 0) {
      if (normals.length) { const idx = normals.pop(); crits.push(idx); }
      nN--; nC++; didFix += ' Severe';
    }
    if (KTR.hasRule(parsed, 'Rending') && naturalCrits > 0 && nN > 0) {
      if (normals.length) { const idx = normals.pop(); crits.push(idx); }
      nN--; nC++; didFix += ' Rending';
    }
    if (KTR.hasRule(parsed, 'Punishing') && naturalCrits > 0 && nF > 0) {
      const idx = fails.pop(); normals.push(idx); nF--; nN++; didFix += ' Punishing';
    }
    s.atk = { rolls, crits, normals, fails, autoNormals: retained,
      counts: { n: nN, c: nC, f: nF },
      bs, critAt,
    };
    s.step = 'rolledAttack';
    const accNote = retained ? ` (+${retained} Accurate)` : '';
    log(`${s.attacker.letter} fires ${atkDice}D6${accNote} at ${s.target.letter}: ${nC} crit · ${nN} normal · ${nF} fail${didFix ? ' (' + didFix.trim() + ')' : ''}.`);
    if (!silent) renderShootModal();
  }

  function rollShootDefence(silent) {
    const s = state.combat.shoot;
    if (!s) return;
    const w = s.weapon;
    const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
    const inCover = s.env.inCover;
    const attackerRetainedCrit = !!(s.atk && s.atk.counts.c > 0);
    const dice = KTR.defenceDiceCount(parsed, inCover, attackerRetainedCrit);
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
    if (!silent) renderShootModal();
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
    // Devastating x: each retained crit immediately inflicts x damage that
    // cannot be blocked — and the crit still resolves normally afterwards.
    const dev = KTR.ruleByName(parsed, 'Devastating');
    if (dev && s.atk.counts.c > 0) {
      s.devDamage = s.atk.counts.c * dev.value;
      s.damage += s.devDamage;
    } else {
      s.devDamage = 0;
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
      const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
      s.atkRemaining = { normals: remN, criticals: remC };
      s.damage = remN * w.normal_dmg + remC * w.crit_dmg;
      // Devastating applies to every retained crit even if it was blocked.
      const dev = KTR.ruleByName(parsed, 'Devastating');
      s.devDamage = (dev && s.atk.counts.c > 0) ? s.atk.counts.c * dev.value : 0;
      s.damage += s.devDamage;
    }
    s.step = 'resolved';
    renderShootModal();
  }

  // Apply one resolved shooting sequence's damage to `target`. Returns true
  // if the target went down.
  function applyShootDamage(attacker, target, weapon, dmg, retainedCrits) {
    const parsed = weapon._parsedRules || (weapon._parsedRules = KTR.parseWeaponRules(weapon.rules));
    target.hp = Math.max(0, target.hp - dmg);
    // Stun: any retained crit worsens the target's APL by 1 until the end
    // of its next activation.
    if (retainedCrits > 0 && KTR.hasRule(parsed, 'Stun') && target.alive) {
      target.aplMod = -1;
      log(`${target.letter} is stunned (-1 APL).`);
    }
    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      target.unitState = 'incapacitated';
      log(`${target.letter} (${target._displayName}) is incapacitated by ${attacker.letter} (${dmg} dmg).`, 'kill');
      registerKill(attacker.team, attacker, target);
      return true;
    }
    if (dmg > 0) log(`${attacker.letter} hits ${target.letter} for ${dmg}.`, 'hit');
    return false;
  }

  // Blast x / Torrent x: after the primary sequence, resolve one sequence
  // against every other visible enemy within x of the primary target
  // (regardless of Conceal). Auto-rolled and optimally allocated.
  function resolveAreaSecondaries(attacker, primary, weapon) {
    const parsed = weapon._parsedRules || (weapon._parsedRules = KTR.parseWeaponRules(weapon.rules));
    const area = KTR.ruleByName(parsed, 'Blast') || KTR.ruleByName(parsed, 'Torrent');
    if (!area || area.value == null) return;
    const radius = area.value;
    const secondaries = state.units.filter(o => {
      if (!o.alive || !o.deployed || o.team === attacker.team || o === primary) return false;
      if (KTR.edgeDist(primary, o) > radius + 1e-3) return false;
      // must be visible to the shooter; Torrent secondaries also must not be
      // within control range of the shooter's friends
      const env = KTR.shootEnv(mapDef, state.combat.pieceState.open, attacker, o);
      if (!env.visible) return false;
      if (area.name === 'Torrent') {
        const engaged = state.units.some(fr => fr.alive && fr.deployed
          && fr.team === attacker.team && KTR.edgeDist(fr, o) <= RC.ENGAGEMENT_RANGE + 1e-3);
        if (engaged) return false;
      }
      return true;
    });
    for (const sec of secondaries) {
      // Roll a full independent sequence, silent + optimal.
      const env = KTR.shootEnv(mapDef, state.combat.pieceState.open, attacker, sec);
      const saved = state.combat.shoot;
      state.combat.shoot = {
        attacker, target: sec, env, weapon,
        step: 'pickWeapon', atk: null, def: null,
        atkRemaining: null, defRemaining: null, damage: 0, done: false,
      };
      rollShootAttack(true);
      rollShootDefence(true);
      allocateShootSavesOptimally();
      const seq = state.combat.shoot;
      log(`${area.name} ${radius}": secondary target ${sec.letter}.`);
      applyShootDamage(attacker, sec, weapon, seq.damage, seq.atk.counts.c);
      state.combat.shoot = saved;
    }
  }

  function commitShoot() {
    const s = state.combat.shoot;
    if (!s) return;
    pushUndo();
    const a = activation();
    const w = s.weapon;
    const parsed = w._parsedRules || (w._parsedRules = KTR.parseWeaponRules(w.rules));
    // Free shots (Guard interrupts) don't spend the active activation's AP.
    if (!s.free && a) {
      a.ap -= RC.SHOOT_AP;
      a.hasShot = true;
      a.history.push({ type: 'shoot', target: s.target.letter, weapon: w.name, dmg: s.damage });
      s.attacker.onGuard = false;
    }
    const killed = applyShootDamage(s.attacker, s.target, w, s.damage, s.atk ? s.atk.counts.c : 0);
    s.killed = killed;
    // Blast / Torrent secondary sequences.
    resolveAreaSecondaries(s.attacker, s.target, w);
    // Hot: after use, roll one D6 — below the weapon's Hit stat inflicts
    // (result × 2) damage on the shooter.
    if (KTR.hasRule(parsed, 'Hot')) {
      const roll = KTR.rollD6();
      if (roll < w.hit) {
        const selfDmg = roll * 2;
        s.attacker.hp = Math.max(0, s.attacker.hp - selfDmg);
        log(`${w.name} overheats! ${s.attacker.letter} takes ${selfDmg} damage (rolled ${roll}).`, 'hit');
        if (s.attacker.hp <= 0) {
          s.attacker.alive = false;
          s.attacker.unitState = 'incapacitated';
          log(`${s.attacker.letter} (${s.attacker._displayName}) is incapacitated by their own weapon.`, 'kill');
          registerKill(s.target.team, null, s.attacker);
        }
      } else {
        log(`${w.name} runs hot but holds (rolled ${roll}).`);
      }
    }
    closeShootModal();
    if (checkVictory()) return;
    afterActionResolved();
  }

  // ── Fight flow ──────────────────────────────────────────────────────
  function fightCandidates(attacker) {
    const out = [];
    const rA = KTR.unitBaseRadius(attacker);
    for (const o of state.units) {
      if (!o.alive || !o.deployed || o.team === attacker.team) continue;
      const reach = RC.ENGAGEMENT_RANGE + rA + KTR.unitBaseRadius(o);
      if (Math.hypot(o.x - attacker.x, o.y - attacker.y) <= reach + 1e-3) out.push(o);
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
      armed: null,       // index of the tapped-but-unresolved die on `next`'s side
      damageA: 0, damageT: 0,
      done: false,
    };
    fightModal.style.display = 'flex';
    // Fast-path: if there's no weapon ambiguity, roll and auto-resolve so the
    // modal opens to the resolved result. Manual die-by-die resolution stays
    // available via the "Resolve manually" button, and "Re-roll" reseeds.
    if (meleeA.length === 1 && meleeT.length === 1) {
      autoRollAndResolveFight();
    }
    renderFightModal();
  }

  function autoRollAndResolveFight() {
    const f = state.combat.fight;
    if (!f) return;
    rollFight(true);
    autoResolveFight();
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
        const done = fightDone(f);
        // Armed die → offer Strike / Block as large tap targets instead of a
        // blocking native confirm() dialog.
        if (!done && f.armed != null) {
          const set = f.next === 'A' ? f.atkA : f.atkT;
          const cat = set.crits.includes(f.armed) ? 'crit' : 'normal';
          const dmg = cat === 'crit' ? set.weapon.crit_dmg : set.weapon.normal_dmg;
          const parryOk = canParry(f, f.next, cat);
          html += `<div class="kt-modal-footer kt-strike-parry">
            <button class="btn-fire" id="kt-fight-strike">Strike (${dmg} dmg)</button>
            <button class="btn-ghost" id="kt-fight-parry" ${parryOk ? '' : 'disabled'}>${parryOk ? 'Block' : 'Block (no valid die)'}</button>
          </div>`;
        }
        const noneSpent = f.atkA && f.atkT && f.atkA.spent.size === 0 && f.atkT.spent.size === 0;
        html += `<div class="kt-modal-footer">
          ${!done && noneSpent && f.atkA.fails.length && state.combat.cp[f.attacker.team] > 0
            ? `<button class="btn-ghost" id="kt-cmd-reroll-A">${escapeHtml(f.attacker.letter)}: Cmd Re-roll (1CP)</button>` : ''}
          ${!done && noneSpent && f.atkT.fails.length && state.combat.cp[f.target.team] > 0
            ? `<button class="btn-ghost" id="kt-cmd-reroll-T">${escapeHtml(f.target.letter)}: Cmd Re-roll (1CP)</button>` : ''}
          ${done ? `<button class="btn-ghost" id="kt-fight-reroll" title="Re-roll both sides">Re-roll</button>` : ''}
          ${done ? '' : `<button class="btn-ghost" id="kt-fight-auto">Auto-resolve</button>`}
          <button class="btn-fire" id="kt-fight-end" ${done ? '' : 'disabled'} title="Apply damage (Enter)">Apply damage</button>
        </div>`;
      }
    }

    fightBody.innerHTML = html;

    const wpA = fightBody.querySelector('#kt-weapon-pick-A');
    if (wpA) wpA.querySelectorAll('.kt-weapon-row').forEach(row => row.addEventListener('click', () => {
      f.weaponA = meleeA[+row.dataset.i];
      if (meleeT.length === 1) { autoRollAndResolveFight(); }
      renderFightModal();
    }));
    const wpT = fightBody.querySelector('#kt-weapon-pick-T');
    if (wpT) wpT.querySelectorAll('.kt-weapon-row').forEach(row => row.addEventListener('click', () => {
      f.weaponT = meleeT[+row.dataset.i];
      if (meleeA.length === 1) { autoRollAndResolveFight(); }
      renderFightModal();
    }));
    const rb = fightBody.querySelector('#kt-fight-roll');
    if (rb) rb.addEventListener('click', () => { autoRollAndResolveFight(); renderFightModal(); });
    const auto = fightBody.querySelector('#kt-fight-auto');
    if (auto) auto.addEventListener('click', () => { autoResolveFight(); renderFightModal(); });
    const strikeBtn = fightBody.querySelector('#kt-fight-strike');
    if (strikeBtn) strikeBtn.addEventListener('click', () => resolveArmedFightDie('strike'));
    const parryBtn = fightBody.querySelector('#kt-fight-parry');
    if (parryBtn) parryBtn.addEventListener('click', () => resolveArmedFightDie('parry'));
    const crA = fightBody.querySelector('#kt-cmd-reroll-A');
    if (crA) crA.addEventListener('click', () => commandRerollFight('A'));
    const crT = fightBody.querySelector('#kt-cmd-reroll-T');
    if (crT) crT.addEventListener('click', () => commandRerollFight('T'));
    const reroll = fightBody.querySelector('#kt-fight-reroll');
    if (reroll) reroll.addEventListener('click', () => { autoRollAndResolveFight(); renderFightModal(); });
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
    if (f.armed != null) {
      return `${who} — <strong>Strike</strong> to deal damage, or <strong>Block</strong> one of the opponent's successes.`;
    }
    return `${who} — tap one of your unresolved dice.`;
  }

  // Can `side` block with a die of category `cat`? Blocking rules: a crit
  // blocks a crit or a normal; a normal blocks a normal only — and never
  // anything if the opponent's weapon is Brutal.
  function canParry(f, side, cat) {
    const oppSet = side === 'A' ? f.atkT : f.atkA;
    // If the opponent's weapon is Brutal, we may only block with crits.
    const oppBrutal = KTR.hasRule(oppSet.parsed, 'Brutal');
    if (oppBrutal && cat !== 'crit') return false;
    if (cat === 'crit') {
      for (const i of oppSet.crits) if (!oppSet.spent.has(i)) return true;
      for (const i of oppSet.normals) if (!oppSet.spent.has(i)) return true;
      return false;
    }
    for (const i of oppSet.normals) if (!oppSet.spent.has(i)) return true;
    return false;
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

  function rollFight(silent) {
    const f = state.combat.fight;
    if (!f) return;
    function rollSide(weapon, opName, wielder) {
      const parsed = weapon._parsedRules || (weapon._parsedRules = KTR.parseWeaponRules(weapon.rules));
      const lethal = KTR.ruleByName(parsed, 'Lethal');
      const critAt = lethal ? lethal.value : 6;
      const hit = wielder ? KTR.effectiveHit(wielder, weapon) : weapon.hit;
      // Accurate x — retain as unrollable normal successes.
      const accurate = KTR.ruleByName(parsed, 'Accurate');
      const retained = accurate ? Math.min(accurate.value, weapon.atk) : 0;
      const out = KTR.rollAttack(weapon.atk - retained, hit, critAt, 0, 0);
      const rolls = out.rolls;
      // Re-roll rules.
      const rerolls = KTR.rerollIndices(parsed, rolls, hit);
      for (const i of rerolls) rolls[i] = KTR.rollD6();
      const crits = [], normals = [], fails = [];
      for (let i = 0; i < rolls.length; i++) {
        const v = rolls[i];
        if (v >= critAt && v >= hit) crits.push(i);
        else if (v >= hit) normals.push(i);
        else fails.push(i);
      }
      // Accurate dice join the pool as pre-retained normal successes so they
      // can be struck / blocked with like any other die.
      for (let i = 0; i < retained; i++) {
        rolls.push(hit);
        normals.push(rolls.length - 1);
      }
      const naturalCrits = crits.length;
      // Severe / Rending / Punishing (Rending and Punishing need a natural crit).
      if (KTR.hasRule(parsed, 'Severe') && crits.length === 0 && normals.length > 0) {
        const idx = normals.pop(); crits.push(idx);
      }
      if (KTR.hasRule(parsed, 'Rending') && naturalCrits > 0 && normals.length > 0) {
        const idx = normals.pop(); crits.push(idx);
      }
      if (KTR.hasRule(parsed, 'Punishing') && naturalCrits > 0 && fails.length > 0) {
        const idx = fails.pop(); normals.push(idx);
      }
      log(`${opName} rolls ${weapon.atk - retained}D6${retained ? ` (+${retained} Accurate)` : ''} (${weapon.name}): ${crits.length} crit · ${normals.length} normal · ${fails.length} fail.`);
      return { rolls, crits, normals, fails, autoNormals: 0, spent: new Set(), shockUsed: false, parsed, weapon };
    }
    f.atkA = rollSide(f.weaponA, f.attacker.letter, f.attacker);
    f.atkT = rollSide(f.weaponT, f.target.letter, f.target);
    // Devastating x: each retained crit immediately inflicts x damage on the
    // opponent, before any strikes or blocks — the dice still resolve later.
    const devA = KTR.ruleByName(f.atkA.parsed, 'Devastating');
    if (devA && f.atkA.crits.length > 0) {
      f.damageT += f.atkA.crits.length * devA.value;
      log(`${f.attacker.letter}'s Devastating inflicts ${f.atkA.crits.length * devA.value} immediately.`);
    }
    const devT = KTR.ruleByName(f.atkT.parsed, 'Devastating');
    if (devT && f.atkT.crits.length > 0) {
      f.damageA += f.atkT.crits.length * devT.value;
      log(`${f.target.letter}'s Devastating inflicts ${f.atkT.crits.length * devT.value} immediately.`);
    }
    f.next = 'A'; // attacker resolves first
    f.step = 'rolled';
    if (!silent) renderFightModal();
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
        if (f.armed === idx) d.classList.add('armed');
        d.onclick = () => onFightDieClick(side, idx, d, cat);
      });
    }
    wire('A', 'fa', f.atkA);
    wire('T', 'fb', f.atkT);
  }

  // Tap a die to arm it; the Strike / Block buttons in the footer resolve it.
  function onFightDieClick(side, idx, dEl, cat) {
    const f = state.combat.fight;
    if (!f) return;
    if (f.next !== side) return;
    f.armed = (f.armed === idx) ? null : idx;
    renderFightModal();
  }

  function resolveArmedFightDie(choice) {
    const f = state.combat.fight;
    if (!f || f.armed == null) return;
    const side = f.next;
    const idx = f.armed;
    const set = side === 'A' ? f.atkA : f.atkT;
    const cat = set.crits.includes(idx) ? 'crit' : 'normal';
    if (choice === 'parry' && !canParry(f, side, cat)) return;
    f.armed = null;
    set.spent.add(idx);
    if (choice === 'strike') {
      const dmg = cat === 'crit' ? set.weapon.crit_dmg : set.weapon.normal_dmg;
      if (side === 'A') f.damageT += dmg;
      else f.damageA += dmg;
      log(`${side === 'A' ? f.attacker.letter : f.target.letter} strikes for ${dmg}.`);
      applyShockOnCritStrike(f, side, set, cat);
    } else {
      // Block: discard one of the opponent's unresolved dice (crit first when
      // blocking with a crit; a normal can only drop a normal).
      const oppSet = side === 'A' ? f.atkT : f.atkA;
      let target = null;
      if (cat === 'crit') {
        for (const i of oppSet.crits) if (!oppSet.spent.has(i)) { target = i; break; }
        if (target == null) for (const i of oppSet.normals) if (!oppSet.spent.has(i)) { target = i; break; }
      } else {
        for (const i of oppSet.normals) if (!oppSet.spent.has(i)) { target = i; break; }
      }
      if (target != null) {
        oppSet.spent.add(target);
        log(`${side === 'A' ? f.attacker.letter : f.target.letter} blocks.`);
      }
    }
    // Switch sides; if other has no dice, stay.
    const otherSide = side === 'A' ? 'T' : 'A';
    if (remainingFightDice(f, otherSide) > 0) f.next = otherSide;
    else f.next = side; // continue on same side
    renderFightModal();
  }

  // Shock: the first time a side strikes with a critical success in the
  // sequence, also discard one of the opponent's unresolved normal successes
  // (or a critical success if there are no normals).
  function applyShockOnCritStrike(f, side, set, cat) {
    if (cat !== 'crit' || set.shockUsed) return;
    if (!KTR.hasRule(set.parsed, 'Shock')) return;
    set.shockUsed = true;
    const oppSet = side === 'A' ? f.atkT : f.atkA;
    let target = null;
    for (const i of oppSet.normals) if (!oppSet.spent.has(i)) { target = i; break; }
    if (target == null) for (const i of oppSet.crits) if (!oppSet.spent.has(i)) { target = i; break; }
    if (target != null) {
      oppSet.spent.add(target);
      log(`Shock! ${side === 'A' ? f.attacker.letter : f.target.letter} discards an opposing success.`);
    }
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
        applyShockOnCritStrike(f, side, set, useCat);
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
    if (!f.free && a) {
      a.ap -= RC.FIGHT_AP;
      a.hasFought = true;
      f.attacker.onGuard = false;
    }
    f.attacker.hp = Math.max(0, f.attacker.hp - f.damageA);
    f.target.hp = Math.max(0, f.target.hp - f.damageT);
    // Stun: a retained crit with a Stun weapon worsens the opponent's APL
    // by 1 until the end of its next activation.
    if (f.atkA && f.atkA.crits.length > 0 && KTR.hasRule(f.atkA.parsed, 'Stun') && f.target.hp > 0) {
      f.target.aplMod = -1;
      log(`${f.target.letter} is stunned (-1 APL).`);
    }
    if (f.atkT && f.atkT.crits.length > 0 && KTR.hasRule(f.atkT.parsed, 'Stun') && f.attacker.hp > 0) {
      f.attacker.aplMod = -1;
      log(`${f.attacker.letter} is stunned (-1 APL).`);
    }
    if (f.attacker.hp <= 0) {
      f.attacker.alive = false; f.attacker.unitState = 'incapacitated';
      log(`${f.attacker.letter} is slain in melee.`, 'kill');
      registerKill(f.target.team, f.target, f.attacker);
    }
    if (f.target.hp <= 0) {
      f.target.alive = false; f.target.unitState = 'incapacitated';
      log(`${f.target.letter} is slain in melee.`, 'kill');
      registerKill(f.attacker.team, f.attacker, f.target);
    }
    if (!f.free && a) a.history.push({ type: 'fight', target: f.target.letter, dmg: f.damageT, taken: f.damageA });
    closeFightModal();
    if (checkVictory()) return;
    afterActionResolved();
  }

  // ── Ploys / CP sheet ────────────────────────────────────────────────
  const ployModal = document.getElementById('ploy-modal');
  const ployBody = document.getElementById('ploy-body');
  const ployCancel = document.getElementById('ploy-cancel');
  const ploysBtn = document.getElementById('ploys-btn');
  let ployTab = 'A';

  function openPloyModal() {
    ployTab = activeTeam();
    ployModal.style.display = 'flex';
    renderPloyModal();
  }
  function closePloyModal() {
    ployModal.style.display = 'none';
    ployBody.innerHTML = '';
  }
  if (ploysBtn) ploysBtn.addEventListener('click', openPloyModal);
  if (ployCancel) ployCancel.addEventListener('click', closePloyModal);

  function ployKey(kind, name) { return kind + ':' + name; }

  function renderPloyModal() {
    if (!ployModal || state.phase !== 'combat') return;
    const team = ployTab;
    const roster = state.rosters[team];
    const faction = roster ? FACTIONS_BY_ID[roster.factionId] : null;
    const cp = state.combat.cp[team];
    const used = state.combat.usedPloys[team];
    const active = state.combat.activePloys[team];
    const tacOp = opsState() && opsState().tacOps[team] ? OPS.tacOpById(opsState().tacOps[team].id) : null;
    const critOp = opsState() ? OPS.critOpById(opsState().critOp) : null;

    let html = `
      <div class="ploy-tabs">
        <button type="button" class="ploy-tab${team === 'A' ? ' active' : ''}" data-team="A">${escapeHtml(teamName('A'))}</button>
        <button type="button" class="ploy-tab${team === 'B' ? ' active' : ''}" data-team="B">${escapeHtml(teamName('B'))}</button>
      </div>
      <div class="ploy-cp">Command Points: <strong>${cp}</strong> · TP ${state.combat.turningPoint}</div>
    `;
    if (critOp) {
      html += `<span class="kt-step-tag">Crit Op — ${escapeHtml(critOp.name)}</span>
        <p class="ploy-text">${escapeHtml(critOp.scoring)}</p>`;
    }
    if (tacOp) {
      html += `<span class="kt-step-tag">Tac Op — ${escapeHtml(tacOp.name)}</span>
        <p class="ploy-text">${escapeHtml(tacOp.scoring)}</p>`;
    }
    if (active.length) {
      html += `<span class="kt-step-tag">Active this turning point</span>
        <p class="ploy-text">${active.map(escapeHtml).join(' · ')}</p>`;
    }
    const section = (title, list, kind) => {
      if (!list || !list.length) return '';
      let out = `<span class="kt-step-tag">${title}</span><div class="ploy-list">`;
      for (const p of list) {
        const cost = p.cp != null ? p.cp : 1;
        const key = ployKey(kind, p.name);
        const spent = used.has(key);
        const cantAfford = cp < cost;
        out += `
          <div class="ploy-row${spent ? ' used' : ''}">
            <div class="ploy-row-main">
              <div class="ploy-name">${escapeHtml(p.name)} <span class="ploy-cost">${cost}CP</span></div>
              <div class="ploy-text">${escapeHtml(p.text)}</div>
            </div>
            <button type="button" class="btn-ghost ploy-use" data-kind="${kind}" data-name="${escapeHtml(p.name)}"
              ${spent || cantAfford ? 'disabled' : ''}>
              ${spent ? 'Used' : cantAfford ? 'No CP' : 'Use'}
            </button>
          </div>`;
      }
      return out + '</div>';
    };
    if (faction) {
      html += section('Strategy Ploys (start of turning point)', faction.strategic_ploys, 'strategic');
      html += section('Firefight Ploys', faction.firefight_ploys, 'firefight');
    } else {
      html += `<p class="ploy-text">No faction data for this side.</p>`;
    }
    html += `<span class="kt-step-tag">Universal</span>
      <p class="ploy-text"><strong>Command Re-roll (1CP)</strong> — after rolling attack or defence dice, re-roll one die. Available directly inside the Shoot and Fight dialogs.</p>`;
    ployBody.innerHTML = html;

    ployBody.querySelectorAll('.ploy-tab').forEach(b => {
      b.addEventListener('click', () => { ployTab = b.dataset.team; renderPloyModal(); });
    });
    ployBody.querySelectorAll('.ploy-use').forEach(b => {
      b.addEventListener('click', () => usePloy(team, b.dataset.kind, b.dataset.name));
    });
  }

  function usePloy(team, kind, name) {
    const roster = state.rosters[team];
    const faction = roster ? FACTIONS_BY_ID[roster.factionId] : null;
    if (!faction) return;
    const list = kind === 'strategic' ? faction.strategic_ploys : faction.firefight_ploys;
    const p = (list || []).find(x => x.name === name);
    if (!p) return;
    const cost = p.cp != null ? p.cp : 1;
    const key = ployKey(kind, name);
    if (state.combat.cp[team] < cost || state.combat.usedPloys[team].has(key)) return;
    state.combat.cp[team] -= cost;
    state.combat.usedPloys[team].add(key);
    state.combat.activePloys[team].push(p.name);
    log(`${teamName(team)} uses ${kind === 'strategic' ? 'strategy' : 'firefight'} ploy: ${p.name} (${cost}CP).`, 'turn');
    renderPloyModal();
    render();
  }

  // Command Re-roll (1CP): re-roll one failed die on the given side of the
  // open shoot state, then re-resolve optimally.
  function commandRerollShoot(side) {
    const s = state.combat.shoot;
    if (!s) return;
    const team = side === 'atk' ? s.attacker.team : s.target.team;
    if (state.combat.cp[team] < 1) return;
    const roll = side === 'atk' ? s.atk : s.def;
    if (!roll || !roll.fails.length) return;
    state.combat.cp[team] -= 1;
    const idx = roll.fails[0];
    const newVal = KTR.rollD6();
    roll.rolls[idx] = newVal;
    // Re-categorise just this die.
    roll.fails = roll.fails.filter(i => i !== idx);
    if (side === 'atk') {
      if (newVal >= roll.critAt && newVal >= roll.bs) roll.crits.push(idx);
      else if (newVal >= roll.bs) roll.normals.push(idx);
      else roll.fails.push(idx);
      roll.counts = { n: roll.normals.length + (roll.autoNormals || 0), c: roll.crits.length, f: roll.fails.length };
    } else {
      if (newVal === 6) roll.crits.push(idx);
      else if (newVal >= roll.save) roll.normals.push(idx);
      else roll.fails.push(idx);
      roll.counts = { n: roll.normals.length + (roll.autoNormals || 0), c: roll.crits.length, f: roll.fails.length };
    }
    log(`${teamName(team)} spends 1CP — Command Re-roll (${newVal}).`);
    allocateShootSavesOptimally();
    s.step = 'resolved';
    renderShootModal();
  }

  function commandRerollFight(side) {
    const f = state.combat.fight;
    if (!f) return;
    const unit = side === 'A' ? f.attacker : f.target;
    const set = side === 'A' ? f.atkA : f.atkT;
    if (!set || !set.fails.length) return;
    if (state.combat.cp[unit.team] < 1) return;
    state.combat.cp[unit.team] -= 1;
    const idx = set.fails[0];
    const newVal = KTR.rollD6();
    set.rolls[idx] = newVal;
    set.fails = set.fails.filter(i => i !== idx);
    const parsed = set.parsed;
    const lethal = KTR.ruleByName(parsed, 'Lethal');
    const critAt = lethal ? lethal.value : 6;
    const hit = KTR.effectiveHit(unit, set.weapon);
    if (newVal >= critAt && newVal >= hit) set.crits.push(idx);
    else if (newVal >= hit) set.normals.push(idx);
    else set.fails.push(idx);
    log(`${teamName(unit.team)} spends 1CP — Command Re-roll (${newVal}).`);
    renderFightModal();
  }

  // ── Wire panel buttons ────────────────────────────────────────────
  document.querySelectorAll('#activation-orders [data-order]').forEach(b => {
    b.addEventListener('click', () => pickOrder(b.dataset.order));
  });
  undoBtn.addEventListener('click', applyUndo);
  endActivationBtn.addEventListener('click', endActivation);
  shootCancel.addEventListener('click', closeShootModal);
  fightCancel.addEventListener('click', closeFightModal);

  // The "More actions" disclosure inside the dock. Persists for the current
  // activation; reset on each new activation in syncActivationPanel.
  let moreActionsOpen = false;
  if (actionMoreToggle) {
    actionMoreToggle.addEventListener('click', () => {
      moreActionsOpen = !moreActionsOpen;
      applyMoreActionsOpen();
    });
  }
  function applyMoreActionsOpen() {
    if (!actionGridMore) return;
    actionGridMore.style.display = moreActionsOpen ? '' : 'none';
    if (actionMoreToggle) {
      actionMoreToggle.setAttribute('aria-expanded', moreActionsOpen ? 'true' : 'false');
      actionMoreToggle.textContent = moreActionsOpen ? 'Fewer actions ▴' : 'More actions ▾';
    }
  }

  // Collapse / expand the bottom dock so the player can peek at the board
  // beneath it. The button is only visible on mobile (CSS) but its handler
  // is harmless on desktop.
  if (activationCollapse) {
    activationCollapse.addEventListener('click', () => {
      const collapsed = activationPanel.classList.toggle('collapsed');
      document.body.classList.toggle('dock-collapsed', collapsed);
      activationCollapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }

  // Sidebar drawer (mobile). The toggle floats on the canvas; tapping
  // outside, the close button, or any of the in-drawer nav links closes it.
  function openSidebar() {
    sidebarEl.classList.add('open');
    document.body.classList.add('sidebar-open');
  }
  function closeSidebar() {
    sidebarEl.classList.remove('open');
    document.body.classList.remove('sidebar-open');
  }
  if (rosterToggle) rosterToggle.addEventListener('click', openSidebar);
  if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);

  // Keep body padding-bottom in sync with the live dock height. Without
  // this the bottom of the canvas / log can be hidden behind the dock
  // when its content changes (orders → actions → move-plot controls).
  function updateDockHeight() {
    if (activationPanel.style.display === 'none') {
      document.body.style.removeProperty('--dock-h');
      return;
    }
    const h = activationPanel.offsetHeight || 0;
    document.body.style.setProperty('--dock-h', h + 'px');
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(updateDockHeight).observe(activationPanel);
  }
  window.addEventListener('resize', updateDockHeight);
  // Tap on the dimmed page outside the sidebar to dismiss.
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('sidebar-open')) return;
    if (sidebarEl.contains(e.target)) return;
    if (rosterToggle && rosterToggle.contains(e.target)) return;
    closeSidebar();
  });

  // ── Keyboard shortcuts (desktop) ─────────────────────────────────────
  // Combat-only bindings. Skipped when a text input is focused so map names
  // and roster fields stay typeable. Modal-aware: Enter advances the open
  // Shoot/Fight modal, Escape closes it. Outside modals, 1-6 fire actions
  // in the order they appear, E/C swap order pre-action, Enter confirms a
  // pending move, U undoes, Space ends the activation.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.phase !== 'combat') return;

    // Modal handling takes priority — keys go to whichever modal is open.
    if (shootModal.style.display === 'flex') {
      if (e.key === 'Escape') { e.preventDefault(); closeShootModal(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); shootModalPrimaryAction(); return; }
      return;
    }
    if (fightModal.style.display === 'flex') {
      if (e.key === 'Escape') { e.preventDefault(); closeFightModal(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); fightModalPrimaryAction(); return; }
      return;
    }
    if (targetPicker.style.display !== 'none') {
      if (e.key === 'Escape') { e.preventDefault(); clearTargetPicker(); return; }
      return;
    }

    const a = activation();
    // Pre-activation: no shortcuts (the user picks a unit on the board).
    if (!a) return;

    // Cancel a pending move with Escape; undo the last waypoint with Backspace.
    if (state.combat.pendingMove) {
      if (e.key === 'Escape')    { e.preventDefault(); cancelPath(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); undoWaypoint(); return; }
      if (e.key === 'Enter')     { e.preventDefault(); commitPath(); return; }
    }

    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); pickOrder('engage'); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); pickOrder('conceal'); return; }
    if (e.key === 'u' || e.key === 'U') { e.preventDefault(); if (!undoBtn.disabled) applyUndo(); return; }
    if (e.key === ' ')                  { e.preventDefault(); endActivation(); return; }

    // 1-9 → nth action button (action-grid first, then more tray).
    if (/^[1-9]$/.test(e.key)) {
      const n = parseInt(e.key, 10) - 1;
      const buttons = [
        ...actionGrid.querySelectorAll('button.action-btn:not([disabled])'),
        ...(actionGridMore ? actionGridMore.querySelectorAll('button.action-btn:not([disabled])') : []),
      ];
      if (buttons[n]) { e.preventDefault(); buttons[n].click(); }
    }
  });

  function shootModalPrimaryAction() {
    const s = state.combat.shoot;
    if (!s) return;
    const order = ['kt-shoot-done', 'kt-resolve', 'kt-roll-defence', 'kt-roll-attack'];
    for (const id of order) {
      const btn = shootBody.querySelector('#' + id);
      if (btn && !btn.disabled) { btn.click(); return; }
    }
  }
  function fightModalPrimaryAction() {
    const f = state.combat.fight;
    if (!f) return;
    const order = ['kt-fight-end', 'kt-fight-roll'];
    for (const id of order) {
      const btn = fightBody.querySelector('#' + id);
      if (btn && !btn.disabled) { btn.click(); return; }
    }
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
        closeSidebar();
        return;
      }
      // Combat: tap an active-team ready unit to start its activation.
      if (state.phase === 'combat' && u.alive && u.team === activeTeam() && !activation() && u.unitState === 'ready') {
        startActivation(u);
        closeSidebar();
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
    const tacA = document.getElementById('vp-tac-A');
    if (tacA) tacA.textContent = state.score.tacOp.A;
    const tacB = document.getElementById('vp-tac-B');
    if (tacB) tacB.textContent = state.score.tacOp.B;
    const cpA = document.getElementById('vp-cp-A');
    if (cpA) cpA.textContent = state.combat.cp.A;
    const cpB = document.getElementById('vp-cp-B');
    if (cpB) cpB.textContent = state.combat.cp.B;
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
      const pb = document.getElementById('ploys-btn');
      if (pb) pb.style.display = state.phase === 'combat' ? '' : 'none';
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
    // Avoid hiding the popup behind the bottom action dock on mobile.
    const dockRect = (document.body.classList.contains('has-activation-dock') && activationPanel.style.display !== 'none')
      ? activationPanel.getBoundingClientRect()
      : null;
    const bottomLimit = dockRect ? dockRect.top : window.innerHeight;
    let left = cx + margin;
    let top  = cy + margin;
    if (left + sw + 8 > window.innerWidth)  left = Math.max(8, cx - sw - margin);
    if (top  + sh + 8 > bottomLimit)        top  = Math.max(8, bottomLimit - sh - 8);
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

    // Pieces (walls + decorations + terrain). When an openable wall has been
    // hatched / breached we tell the renderer so the gap is visible.
    const openSet = (state.combat && state.combat.pieceState && state.combat.pieceState.open) || null;
    (mapDefRaw.pieces || []).forEach((p, idx) => {
      const isOpen = !!(openSet && openSet.has(idx));
      KT.drawPieceCanvas(ctx, p, s, s, { isOpen });
    });

    // Objectives — during combat the marker shows live control (combined APL
    // within 1") as a halo, while still rendering the map's authored owner
    // on the inner disc.
    const inCombat = (state.phase === 'combat' || state.phase === 'over');
    for (const o of mapDef.objectives || []) {
      const ctrl = inCombat ? objectiveControl(o) : null;
      // 1" control radius (only shown in combat). The outline is drawn at the
      // engagement range plus the active operative's base radius (or the
      // selected unit, or a default 28mm base) so that the bubble matches the
      // edge-to-edge measurement we actually use.
      if (inCombat) {
        const refUnit = (state.combat.activation && state.combat.activation.unit)
          || state.combat.selectedId
          || null;
        const refR = refUnit ? KTR.unitBaseRadius(refUnit) : (DEFAULT_BASE_MM / 2) / MM_PER_INCH;
        const rad = (RC.ENGAGEMENT_RANGE + refR) * s;
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

        // Enemy control-range bubbles so the user can see the no-go zones for
        // Reposition / Dash and the must-end-in zone for Charge. Drawn at
        // (1" + active unit's base radius + enemy's base radius) — the
        // distance at which the active operative's CENTRE may not approach,
        // matching the edge-to-edge engagement-range rule.
        const enemies = state.units.filter(o => o.alive && o.deployed && o.team !== u.team);
        const showCRColor = (pm.kind === 'reposition' || pm.kind === 'dash')
          ? 'rgba(184,32,58,0.18)'
          : (pm.kind === 'charge' ? 'rgba(122,156,62,0.18)' : 'rgba(122,156,62,0.10)');
        const showCRStroke = (pm.kind === 'reposition' || pm.kind === 'dash')
          ? 'rgba(184,32,58,0.55)'
          : (pm.kind === 'charge' ? 'rgba(122,156,62,0.65)' : 'rgba(122,156,62,0.40)');
        const activeR = unitRadiusMax(u);
        for (const e of enemies) {
          const reach = RC.ENGAGEMENT_RANGE + activeR + KTR.unitBaseRadius(e);
          ctx.fillStyle = showCRColor;
          ctx.strokeStyle = showCRStroke;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(e.x * s, e.y * s, reach * s, 0, Math.PI * 2);
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
      // Distance is measured to the closest point on the wall segment so
      // long hatchways light up correctly when the operative is touching
      // any part of them. The highlight is drawn as a stroke along the
      // segment itself instead of a tiny circle at the midpoint.
      if (a) {
        const u = a.unit;
        for (const o of (mapDef.openable || [])) {
          const w = (mapDef.walls || []).find(w => w.pieceIndex === o.pieceIndex);
          const d = openableDistance(o, u);
          if (d > 4) continue;
          const isOpen = state.combat.pieceState.open.has(o.pieceIndex);
          const inReach = d <= RC.ENGAGEMENT_RANGE + 1e-3;
          ctx.strokeStyle = inReach
            ? (o.kind === 'hatchway' ? 'rgba(122,156,62,0.85)' : 'rgba(201,122,58,0.85)')
            : 'rgba(255,255,255,0.18)';
          ctx.lineWidth = inReach ? 4 : 2;
          if (w) {
            ctx.beginPath();
            ctx.moveTo(w.x1 * s, w.y1 * s);
            ctx.lineTo(w.x2 * s, w.y2 * s);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.arc(o.x * s, o.y * s, 0.7 * s, 0, Math.PI * 2);
            ctx.stroke();
          }
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
    syncBoardArmed();
  }

  function syncBoardArmed() {
    const armed = (state.phase === 'deploy' && state.deploy && state.deploy.pendingUnit)
      || (state.phase === 'combat' && state.combat && state.combat.pendingMove);
    document.body.classList.toggle('board-armed', !!armed);
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

  function handleBoardTap(p, evt) {
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
  }

  let suppressNextCanvasClick = false;

  canvas.addEventListener('click', (evt) => {
    if (suppressNextCanvasClick) { suppressNextCanvasClick = false; return; }
    handleBoardTap(eventToBoard(evt), evt);
  });

  // ── Hold-and-drag with magnifier (mobile precision tap) ──────────────
  // Press-and-hold on the board for ~220ms to summon a circular magnifier
  // offset above the finger; drag to fine-tune the target, then lift to
  // commit the tap at the crosshair. Quick taps still flow through the
  // regular click handler. Mouse input is left untouched.
  const HOLD_MS              = 220;
  const HOLD_MOVE_CANCEL_PX  = 12;
  const MAG_SIZE_PX          = 140;
  const MAG_ZOOM             = 2.5;
  const MAG_OFFSET_PX        = 110;

  const boardStage = canvas.parentElement;
  const magEl = document.createElement('div');
  magEl.className = 'tap-magnifier';
  magEl.style.display = 'none';
  const magCanvas = document.createElement('canvas');
  magEl.appendChild(magCanvas);
  const magCross = document.createElement('div');
  magCross.className = 'tap-magnifier-cross';
  magEl.appendChild(magCross);
  boardStage.appendChild(magEl);
  const magCtx = magCanvas.getContext('2d');

  let holdDrag = null;

  function clientToBoard(cx, cy) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((cx - rect.left) / rect.width)  * BOARD.width,
      y: ((cy - rect.top)  / rect.height) * BOARD.height,
    };
  }

  function activateHoldDrag() {
    if (!holdDrag) return;
    holdDrag.active = true;
    try { canvas.setPointerCapture(holdDrag.pointerId); } catch (_) {}
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
    // Hide the stat block so the magnifier is the focal element while
    // the user is fine-tuning their tap.
    hideStatBlock(true);
    magEl.style.display = 'block';
    drawHoldMagnifier();
  }

  function cancelHoldDrag() {
    if (!holdDrag) return;
    if (holdDrag.timer) clearTimeout(holdDrag.timer);
    if (holdDrag.active) {
      try { canvas.releasePointerCapture(holdDrag.pointerId); } catch (_) {}
    }
    magEl.style.display = 'none';
    holdDrag = null;
  }

  function drawHoldMagnifier() {
    if (!holdDrag || !holdDrag.active) return;
    const stageRect = boardStage.getBoundingClientRect();
    const canRect   = canvas.getBoundingClientRect();

    // Update hoverPt so the existing on-board previews (deploy ghost,
    // move-path next leg) follow the finger as it drags.
    state.combat.hoverPt = clientToBoard(holdDrag.currentCx, holdDrag.currentCy);
    if (state.phase === 'deploy' || state.phase === 'combat') drawBoard();

    // Magnifier center, in CSS px relative to .board-stage. Default to
    // above the finger; flip below when too close to the top edge.
    let mx = holdDrag.currentCx - stageRect.left;
    let my = holdDrag.currentCy - stageRect.top - MAG_OFFSET_PX;
    if (my < MAG_SIZE_PX / 2 + 6) {
      my = holdDrag.currentCy - stageRect.top + MAG_OFFSET_PX;
    }
    const halfW = MAG_SIZE_PX / 2 + 4;
    const halfH = MAG_SIZE_PX / 2 + 4;
    mx = Math.max(halfW, Math.min(stageRect.width  - halfW, mx));
    my = Math.max(halfH, Math.min(stageRect.height - halfH, my));
    magEl.style.left = mx + 'px';
    magEl.style.top  = my + 'px';

    // Source rectangle on the main canvas, in backing-store px.
    const scaleX = canvas.width  / canRect.width;
    const scaleY = canvas.height / canRect.height;
    const srcCx  = (holdDrag.currentCx - canRect.left) * scaleX;
    const srcCy  = (holdDrag.currentCy - canRect.top)  * scaleY;
    const sw = (MAG_SIZE_PX / MAG_ZOOM) * scaleX;
    const sh = (MAG_SIZE_PX / MAG_ZOOM) * scaleY;

    const target = Math.round(MAG_SIZE_PX * (window.devicePixelRatio || 1));
    if (magCanvas.width !== target) {
      magCanvas.width  = target;
      magCanvas.height = target;
      magCanvas.style.width  = MAG_SIZE_PX + 'px';
      magCanvas.style.height = MAG_SIZE_PX + 'px';
    }
    magCtx.imageSmoothingEnabled = true;
    magCtx.fillStyle = '#0f0b09';
    magCtx.fillRect(0, 0, magCanvas.width, magCanvas.height);
    magCtx.drawImage(
      canvas,
      srcCx - sw / 2, srcCy - sh / 2, sw, sh,
      0, 0, magCanvas.width, magCanvas.height,
    );
  }

  canvas.addEventListener('pointerdown', (evt) => {
    if (evt.pointerType === 'mouse') return;
    if (holdDrag) cancelHoldDrag();
    holdDrag = {
      pointerId: evt.pointerId,
      startCx:   evt.clientX,
      startCy:   evt.clientY,
      currentCx: evt.clientX,
      currentCy: evt.clientY,
      active:    false,
      timer:     null,
    };
    holdDrag.timer = setTimeout(activateHoldDrag, HOLD_MS);
  });

  canvas.addEventListener('pointermove', (evt) => {
    if (!holdDrag || evt.pointerId !== holdDrag.pointerId) return;
    holdDrag.currentCx = evt.clientX;
    holdDrag.currentCy = evt.clientY;
    if (holdDrag.active) {
      drawHoldMagnifier();
    } else {
      const dx = holdDrag.currentCx - holdDrag.startCx;
      const dy = holdDrag.currentCy - holdDrag.startCy;
      if (dx * dx + dy * dy > HOLD_MOVE_CANCEL_PX * HOLD_MOVE_CANCEL_PX) {
        cancelHoldDrag();
      }
    }
  });

  function endHoldDrag(evt, commit) {
    if (!holdDrag || evt.pointerId !== holdDrag.pointerId) return;
    const wasActive = holdDrag.active;
    if (commit && wasActive) {
      const p = clientToBoard(holdDrag.currentCx, holdDrag.currentCy);
      // The browser fires a synthetic click after pointerup on a tap; we
      // already delivered the tap via handleBoardTap, so swallow that one.
      suppressNextCanvasClick = true;
      setTimeout(() => { suppressNextCanvasClick = false; }, 700);
      cancelHoldDrag();
      handleBoardTap(p, evt);
    } else {
      cancelHoldDrag();
      if (wasActive) {
        // Drag was abandoned — clear the lingering hover preview.
        state.combat.hoverPt = null;
        if (state.phase === 'deploy' || state.phase === 'combat') drawBoard();
      }
    }
  }
  canvas.addEventListener('pointerup',     (evt) => endHoldDrag(evt, true));
  canvas.addEventListener('pointercancel', (evt) => endHoldDrag(evt, false));

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

  // ── Test / review hook ───────────────────────────────────────────────
  // Skips the team-picker → initiative → deploy interactions so the
  // headless ui-review harness (tools/ui-review/capture.mjs) can land
  // directly in combat states for screenshots and a11y audits. Not
  // referenced by any production code path; safe to call from the
  // browser console too if you want to poke at the combat UI without
  // playing a full game.
  window.__kt_test = {
    // Build units from saved rosters, lay them out in a tidy grid inside
    // each team's deploy zone, and enter combat. `first` is the team that
    // gets the first activation of TP1.
    jumpToCombat({ rosterAId, rosterBId, first = 'A' } = {}) {
      const rosters = loadRosters();
      if (rosters.length < 1) throw new Error('no rosters in localStorage');
      state.rosters.A = rosters.find(r => r.id === rosterAId) || rosters[0];
      state.rosters.B = rosters.find(r => r.id === rosterBId) || rosters[1] || rosters[0];
      state.units = [
        ...unitsFromRoster(state.rosters.A, 'A'),
        ...unitsFromRoster(state.rosters.B, 'B'),
      ];
      const layoutTeam = (team) => {
        const zone = KT.deployZone(mapDef, team);
        const units = state.units.filter(u => u.team === team);
        const cols = Math.ceil(Math.sqrt(units.length));
        const rows = Math.ceil(units.length / cols);
        const dx = zone.w / (cols + 1);
        const dy = zone.h / (rows + 1);
        units.forEach((u, i) => {
          const c = i % cols, r = Math.floor(i / cols);
          u.x = zone.x + (c + 1) * dx;
          u.y = zone.y + (r + 1) * dy;
          u.deployed = true;
        });
      };
      layoutTeam('A');
      layoutTeam('B');
      state.deploy.first = first;
      startCombat();
    },
    // Start `letter`'s activation. Forces activeTeam to that unit's team
    // so the harness can pick either side without juggling turn order.
    startActivation(letter) {
      const u = state.units.find(x => x.letter === letter);
      if (!u) throw new Error(`no unit with letter ${letter}`);
      state.combat.activeTeam = u.team;
      u.unitState = 'ready';
      u.ap = u.apl;
      startActivation(u);
    },
    // Open the shoot modal. Defaults to the first valid target if
    // `targetLetter` is omitted.
    openShoot(shooterLetter, targetLetter) {
      const u = state.units.find(x => x.letter === shooterLetter);
      if (!u) throw new Error(`no shooter ${shooterLetter}`);
      if (!activation() || activation().unit !== u) {
        window.__kt_test.startActivation(shooterLetter);
      }
      const cands = shootCandidates(u);
      const cand = targetLetter
        ? cands.find(c => c.target.letter === targetLetter)
        : cands[0];
      if (!cand) throw new Error(`no valid shoot target${targetLetter ? ' ' + targetLetter : ''} for ${shooterLetter}`);
      openShootModal(u, cand.target, cand.env);
    },
    // Open the fight modal. Teleports the attacker next to the defender
    // so engagement-range checks pass — visual review only, not gameplay.
    openFight(attackerLetter, defenderLetter) {
      const a = state.units.find(x => x.letter === attackerLetter);
      const t = state.units.find(x => x.letter === defenderLetter);
      if (!a) throw new Error(`no attacker ${attackerLetter}`);
      if (!t) throw new Error(`no defender ${defenderLetter}`);
      a.x = t.x + 0.5; a.y = t.y;
      if (!activation() || activation().unit !== a) {
        window.__kt_test.startActivation(attackerLetter);
      }
      openFightModal(a, t);
    },
    // Escape hatch for the harness if it needs to inspect runtime state.
    state() { return state; },
    // Force the scoreboard into a mid-game state for screenshots: bumps
    // the turning point and writes non-zero kill / crit op counts so the
    // VP board, batch chip, and phase chip render with realistic content
    // rather than the all-zeros opening state.
    setVP({ tp = 2, killA = 0, critA = 0, killB = 0, critB = 0, kills } = {}) {
      state.combat.turningPoint = tp;
      state.score.killOp.A = killA;
      state.score.killOp.B = killB;
      state.score.critOp.A = critA;
      state.score.critOp.B = critB;
      if (kills) {
        state.score.kills.A = kills.A ?? state.score.kills.A;
        state.score.kills.B = kills.B ?? state.score.kills.B;
      }
      phaseChip.textContent = `Turning Point ${tp}`;
      renderVpBoard();
      syncActivationPanel();
      render();
    },
    // Wipe `losingTeam` so checkVictory() fires and the game-over overlay
    // appears. Optional `kills` boosts the winning team's Kill Op count for
    // a more realistic score on the final card; defaults to wiping the
    // losing team's full starting size.
    triggerGameOver(losingTeam = 'B', { kills } = {}) {
      const winningTeam = losingTeam === 'A' ? 'B' : 'A';
      state.units.filter(u => u.team === losingTeam).forEach(u => {
        u.alive = false;
        u.hp = 0;
        u.unitState = 'incapacitated';
      });
      state.score.kills[winningTeam] = kills ?? state.score.startSize[winningTeam];
      // Also bump the winner's Crit Op count so the overlay shows non-zero
      // VP on both ops — purely cosmetic for screenshots.
      state.score.critOp[winningTeam] = 3;
      checkVictory();
    },
    // Advance the shoot modal one step. Requires the modal to already be
    // open (via openShoot). `to` is the step name from the shoot state
    // machine: 'rolledAttack' | 'rolledDefence' | 'resolved'.
    advanceShoot(to) {
      const s = state.combat.shoot;
      if (!s) throw new Error('shoot modal not open');
      if (to === 'rolledAttack' || to === 'rolledDefence' || to === 'resolved') {
        if (s.step === 'pickWeapon') rollShootAttack();
      }
      if (to === 'rolledDefence' || to === 'resolved') {
        if (s.step === 'rolledAttack') rollShootDefence();
      }
      if (to === 'resolved') {
        if (s.step === 'rolledDefence') {
          allocateShootSavesOptimally();
          s.step = 'resolved';
          renderShootModal();
        }
      }
    },
    // Roll the dice in the open fight modal — leaves the user at the
    // dice-allocation step (alternating strike / parry).
    rollFightDice() {
      const f = state.combat.fight;
      if (!f) throw new Error('fight modal not open');
      if (f.step === 'pickWeapon') rollFight();
    },
    // Find a pair of (Team A, Team B) positions with clear shoot LoS by
    // sweeping a coarse grid across each half-board, repositioning the
    // first alive operative on each team into the first valid pair found.
    // Necessary on dense maps (e.g. tomb-approved-2) where the default
    // grid layout from jumpToCombat puts every unit behind a wall —
    // shootCandidates returns empty for every shooter and openShoot
    // throws "no valid target".
    findClearShoot() {
      const a = state.units.find(u => u.team === 'A' && u.alive);
      const b = state.units.find(u => u.team === 'B' && u.alive);
      if (!a || !b) return null;
      // Quick path: existing layout already has a clear pair.
      const teamA = state.units.filter(u => u.team === 'A' && u.alive);
      const teamB = state.units.filter(u => u.team === 'B' && u.alive);
      for (const sa of teamA) for (const sb of teamB) {
        const env = KTR.shootEnv(mapDef, state.combat.pieceState.open, sa, sb);
        if (env.visible) return { shooter: sa.letter, target: sb.letter };
      }
      // Fallback: brute-force scan a 3-inch grid across each half-board
      // for the first valid pair, repositioning a/b in place.
      const W = KT.TOMB_BOARD.width, H = KT.TOMB_BOARD.height;
      const splitV = (mapDef.split !== 'horizontal');
      const aXs = splitV ? range(2, W / 2, 3) : range(2, W, 3);
      const aYs = splitV ? range(2, H, 3) : range(H / 2, H, 3);
      const bXs = splitV ? range(W / 2 + 1, W, 3) : range(2, W, 3);
      const bYs = splitV ? range(2, H, 3) : range(2, H / 2, 3);
      for (const ax of aXs) for (const ay of aYs) {
        a.x = ax; a.y = ay;
        for (const bx of bXs) for (const by of bYs) {
          b.x = bx; b.y = by;
          const env = KTR.shootEnv(mapDef, state.combat.pieceState.open, a, b);
          if (env.visible) return { shooter: a.letter, target: b.letter };
        }
      }
      return null;

      function range(start, end, step) {
        const out = [];
        for (let v = start; v < end; v += step) out.push(v);
        return out;
      }
    },
  };

  // ── AI hook API ─────────────────────────────────────────────────────
  // Controlled surface for ai.js (solo mode). The AI drives the same code
  // paths as the human UI — actions validate exactly the same way.
  window.__kt_ai_api = {
    state: () => state,
    mapDef: () => mapDef,
    KTR,
    TEAM_INFO,
    teamName,
    readyUnits,
    activation,
    activeTeam,
    startActivation: (u) => startActivation(u),
    pickOrder,
    endActivation,
    startCounteract,
    passCounteract,
    counteractCandidates,
    shootCandidates,
    fightCandidates,
    missionActionsFor,
    performMissionAction,
    performGuard,
    unitContests,
    objectiveControl,
    effectiveWalls,
    validDeployPoint,
    tryPlacePending,
    clearTargetPicker,
    // Probe a single-leg move of `kind` to (x, y): returns null if legal,
    // else the reason. Leaves no state behind.
    probeMove(kind, x, y) {
      const a = activation();
      if (!a) return 'No activation.';
      const u = a.unit;
      const v = KTR.validate;
      const vres = kind === 'reposition' ? v.reposition(u, a)
        : kind === 'dash' ? v.dash(u, a)
        : kind === 'charge' ? v.charge(u, a, state.units)
        : v.fallBack(u, a, state.units);
      if (vres) return vres;
      let max = kind === 'dash' ? RC.DASH_INCHES
        : kind === 'charge' ? KTR.effectiveMove(u) + RC.CHARGE_BONUS
        : KTR.effectiveMove(u);
      if (a.counteract) max = Math.min(max, 2);
      const pm = { kind, maxInches: max, waypoints: [{ x: u.x, y: u.y }], used: 0 };
      const extendReason = canExtendPathReason(u, pm, x, y);
      if (extendReason) return extendReason;
      pm.waypoints.push({ x, y });
      return endpointReason(u, pm);
    },
    // Execute a move along one or more legs; returns true on success.
    doMove(kind, x, y) {
      const a = activation();
      if (!a) return false;
      const pts = Array.isArray(x) ? x : [{ x, y }];
      onActionClick(kind);
      clearTargetPicker();
      if (!state.combat.pendingMove) return false;
      for (const p of pts) addWaypoint(p.x, p.y);
      if (state.combat.pendingMove.waypoints.length < 2) { cancelPath(); return false; }
      const apBefore = a.ap;
      commitPath();
      if (state.combat.pendingMove) { cancelPath(); return false; }
      return a.ap < apBefore;
    },
    // Hatchway helpers for AI pathing.
    nearestOpenable,
    isPieceOpen: (pieceIndex) => state.combat.pieceState.open.has(pieceIndex),
    performOpenHatchway,
    unitOccupiesCircle,
    moveBlockedByWalls: (x1, y1, x2, y2, r) =>
      KTR.moveBlockedByWalls(mapDef, state.combat.pieceState.open, x1, y1, x2, y2, r),
    // Open + resolve a shoot against `target` with the best-named weapon.
    // Leaves the resolved modal open; call commitShoot() to apply.
    doShoot(target, weaponName) {
      const a = activation();
      if (!a) return false;
      const u = a.unit;
      const cands = shootCandidates(u);
      const cand = cands.find(c => c.target === target);
      if (!cand) return false;
      openShootModal(u, cand.target, cand.env);
      const s = state.combat.shoot;
      if (!s) return false;
      if (weaponName) {
        const w = (u.weapons || []).find(x => !x.is_melee && x.name === weaponName);
        if (w && weaponReaches(u, w, target)) s.weapon = w;
      }
      autoResolveShoot();
      renderShootModal();
      return true;
    },
    commitShoot,
    doFight(target, weaponName) {
      const a = activation();
      if (!a) return false;
      const u = a.unit;
      const cands = fightCandidates(u);
      if (!cands.includes(target)) return false;
      openFightModal(u, target);
      const f = state.combat.fight;
      if (!f) return false;
      if (weaponName) {
        const w = (u.weapons || []).find(x => x.is_melee && x.name === weaponName);
        if (w) f.weaponA = w;
      }
      autoRollAndResolveFight();
      renderFightModal();
      return true;
    },
    commitFight,
    closeShootModal,
    closeFightModal,
  };

  // Notify the AI (if loaded) whenever the game state advances. ai.js
  // debounces and inspects the state itself.
  function aiPoke() {
    if (window.KT_AI && state.aiTeam) window.KT_AI.poke();
  }
  const _origSync = syncActivationPanel;
  syncActivationPanel = function () {
    _origSync.apply(this, arguments);
    aiPoke();
  };
})();
