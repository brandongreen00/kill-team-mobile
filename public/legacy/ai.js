// Solo-mode AI. Commands one side (state.aiTeam, currently Red) through the
// exact same action paths the human UI uses, via window.__kt_ai_api.
//
// Tuned for Plague Marines — few, durable operatives with short-ranged guns
// and strong melee — but plays any roster: the heuristics only read weapon
// stats, wounds, and board geometry.
//
// Decision model per activation (APL is almost always 2):
//   1. Score the best available Shoot / Charge+Fight right now.
//   2. Score the best "move then shoot" firing position.
//   3. Score objective progress (move onto / toward the most valuable
//      objective, performing the crit-op mission action when standing on it).
//   4. Execute the highest-value plan; spend leftover AP on a mission
//      action, a second move toward the objective, or Guard.
// Orders: Engage when shooting/charging this activation, otherwise Conceal.

(function (root) {
  const TICK_MS = 550;          // pacing between AI decisions (human-watchable)
  let timer = null;
  let busy = false;

  function api() { return root.__kt_ai_api; }

  function start() {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // ── Weapon math ─────────────────────────────────────────────────────
  function parsed(A, w) {
    return w._parsedRules || (w._parsedRules = A.KTR.parseWeaponRules(w.rules));
  }
  // Expected damage of one shooting sequence, ignoring defence (used for
  // RANKING only — relative order is what matters).
  function expectedShootDamage(A, shooter, w, target, inCover) {
    const p = parsed(A, w);
    const lethal = A.KTR.ruleByName(p, 'Lethal');
    const critAt = lethal ? lethal.value : 6;
    const hit = A.KTR.effectiveHit(shooter, w);
    const pCrit = (7 - critAt) / 6;
    const pNorm = Math.max(0, (critAt - hit) / 6);
    let atk = w.atk;
    const acc = A.KTR.ruleByName(p, 'Accurate');
    let expN = atk * pNorm, expC = atk * pCrit;
    if (acc) { expN += acc.value * (1 - pNorm - pCrit); }
    // Defence: ~3 dice at save+, cover retains one normal.
    const save = target.save;
    const pSave = Math.max(0, (7 - save) / 6);
    let defDice = 3;
    const pierce = A.KTR.ruleByName(p, 'Piercing');
    if (pierce) defDice -= pierce.value;
    let blocked = Math.max(0, defDice) * pSave * 0.9;
    if (inCover && !A.KTR.hasRule(p, 'Saturate')) blocked += 0.9;
    if (A.KTR.hasRule(p, 'Brutal')) blocked *= 0.4;
    const netN = Math.max(0, expN - Math.max(0, blocked - expC * 0.3));
    const dev = A.KTR.ruleByName(p, 'Devastating');
    let dmg = netN * w.normal_dmg + expC * w.crit_dmg;
    if (dev) dmg += expC * dev.value;
    if (A.KTR.hasRule(p, 'Hot')) dmg -= 1.2; // expected self-damage tax
    return Math.max(0, dmg);
  }
  function expectedFightDamage(A, u, w, target) {
    const p = parsed(A, w);
    const lethal = A.KTR.ruleByName(p, 'Lethal');
    const critAt = lethal ? lethal.value : 6;
    const hit = A.KTR.effectiveHit(u, w);
    const pCrit = (7 - critAt) / 6;
    const pNorm = Math.max(0, (critAt - hit) / 6);
    // Opponent blocks roughly half their successes against us.
    const gross = w.atk * (pNorm * w.normal_dmg + pCrit * w.crit_dmg);
    return gross * 0.72;
  }
  function bestRangedWeapon(A, shooter, target, inCover) {
    let best = null, bestDmg = -1;
    for (const w of shooter.weapons || []) {
      if (w.is_melee) continue;
      if (A.KTR.edgeDist(shooter, target) > A.KTR.weaponRange(w) + 1e-3) continue;
      if (shooter.order === 'conceal' && !A.KTR.hasRule(parsed(A, w), 'Silent')) continue;
      const d = expectedShootDamage(A, shooter, w, target, inCover);
      if (d > bestDmg) { bestDmg = d; best = w; }
    }
    return best ? { weapon: best, dmg: bestDmg } : null;
  }
  function bestMeleeWeapon(A, u, target) {
    let best = null, bestDmg = -1;
    for (const w of u.weapons || []) {
      if (!w.is_melee) continue;
      const d = expectedFightDamage(A, u, w, target);
      if (d > bestDmg) { bestDmg = d; best = w; }
    }
    return best ? { weapon: best, dmg: bestDmg } : null;
  }

  // Value of dealing `dmg` to `target`: kills are worth far more, wounded
  // and objective-holding targets are juicier.
  function damageValue(A, dmg, target) {
    const s = api().state();
    let v = Math.min(dmg, target.hp);
    if (dmg >= target.hp) v += 6 + target.maxHp * 0.3;      // kill bonus
    const map = A.mapDef();
    for (const obj of (map.objectives || [])) {
      if (Math.hypot(target.x - obj.x, target.y - obj.y) < 3) { v += 1.5; break; }
    }
    return v;
  }

  // ── Board helpers ───────────────────────────────────────────────────
  function enemies(A, team) {
    return A.state().units.filter(u => u.alive && u.deployed && u.team !== team);
  }
  function friends(A, team) {
    return A.state().units.filter(u => u.alive && u.deployed && u.team === team);
  }
  function objectiveValue(A, obj, team) {
    const control = A.objectiveControl(obj);
    if (control === team) return 0.6;         // keep holding
    if (control === 'neutral') return 2.2;    // grab it
    return 2.8;                                // steal it
  }
  // Reachability field: ONE Dijkstra-ish sweep over a 0.5" grid, routing
  // around walls (through open hatchways). Each node records its cost and
  // whether the route touched enemy control range. Per-action candidate
  // sets are then filtered from this shared field.
  const GRID = 0.5;
  function computeReach(A, u, maxIn) {
    const r = A.KTR.unitBaseRadius(u);
    const key = (x, y) => Math.round(x * 4) + ':' + Math.round(y * 4);
    const es = enemies(A, u.team);
    const inCR = (x, y) =>
      es.some(e => Math.hypot(e.x - x, e.y - y) - r - A.KTR.unitBaseRadius(e) <= 1.0 + 1e-3);
    const startNode = { x: u.x, y: u.y, cost: 0, prev: null, crOnPath: false };
    const seen = new Map([[key(u.x, u.y), startNode]]);
    const queue = [startNode];
    while (queue.length) {
      const cur = queue.shift();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = cur.x + dx * GRID, ny = cur.y + dy * GRID;
        if (nx < 1 || ny < 1 || nx > 27 || ny > 23) continue;
        const cost = cur.cost + ((dx && dy) ? GRID * 1.45 : GRID);
        if (cost > maxIn + 0.01) continue;
        const k = key(nx, ny);
        if (seen.has(k) && seen.get(k).cost <= cost) continue;
        if (A.moveBlockedByWalls(cur.x, cur.y, nx, ny, r)) continue;
        const node = { x: nx, y: ny, cost, prev: cur, crOnPath: cur.crOnPath || inCR(nx, ny) };
        seen.set(k, node);
        queue.push(node);
      }
    }
    const nodes = [];
    for (const node of seen.values()) {
      if (node.cost === 0) continue;
      if (A.unitOccupiesCircle(node.x, node.y, r, u)) continue;
      nodes.push(node);
    }
    return { nodes, r };
  }
  // Candidate list for a specific move action, drawn from the shared field.
  function moveCandidates(A, u, kind, maxIn, reach) {
    const avoidCR = kind === 'reposition' || kind === 'dash';
    const out = [];
    for (const node of reach.nodes) {
      if (node.cost > maxIn + 0.01) continue;
      if (avoidCR && node.crOnPath) continue;
      const path = simplifyPath(A, node, maxIn, reach.r);
      if (path) out.push({ x: node.x, y: node.y, path });
    }
    return out;
  }
  // Collapse the BFS parent chain into as few straight legs as possible,
  // keeping the rounded-up total within budget.
  function simplifyPath(A, node, maxIn, r) {
    const chain = [];
    for (let n = node; n; n = n.prev) chain.unshift({ x: n.x, y: n.y });
    const legs = [];
    let i = 0;
    while (i < chain.length - 1) {
      let j = chain.length - 1;
      for (; j > i + 1; j--) {
        if (!A.moveBlockedByWalls(chain[i].x, chain[i].y, chain[j].x, chain[j].y, r)) break;
      }
      legs.push(chain[j]);
      i = j;
    }
    let used = 0, prev = chain[0];
    for (const leg of legs) {
      used += Math.ceil(Math.hypot(leg.x - prev.x, leg.y - prev.y) - 1e-6);
      prev = leg;
    }
    if (used > maxIn) return null;
    return legs;
  }

  function exposureAt(A, u, x, y) {
    // How many enemies could see this spot (cheap LoS via shootEnv on a
    // ghost position).
    const ghost = { ...u, x, y };
    let n = 0;
    for (const e of enemies(A, u.team)) {
      const env = A.KTR.shootEnv(A.mapDef(), A.state().combat.pieceState.open, e, ghost);
      if (env.visible && !env.inCover) n += 1;
      else if (env.visible) n += 0.4;
    }
    return n;
  }

  // ── Plan evaluation ────────────────────────────────────────────────
  function bestShootNow(A, u) {
    let best = null;
    for (const c of A.shootCandidates(u)) {
      const bw = bestRangedWeapon(A, u, c.target, c.env.inCover);
      if (!bw) continue;
      const val = damageValue(A, bw.dmg, c.target);
      if (!best || val > best.val) best = { target: c.target, weapon: bw.weapon, val, dmg: bw.dmg };
    }
    return best;
  }

  function bestChargeFight(A, u, reach, maxIn) {
    const a = A.activation();
    if (!a || A.KTR.validate.charge(u, a, A.state().units)) return null;
    const es = enemies(A, u.team);
    const rU = A.KTR.unitBaseRadius(u);
    let best = null;
    for (const p of moveCandidates(A, u, 'charge', maxIn, reach)) {
      // The endpoint must be within an enemy's control range.
      const near = es.filter(e =>
        Math.hypot(e.x - p.x, e.y - p.y) - rU - A.KTR.unitBaseRadius(e) <= 1.0 + 1e-3);
      if (!near.length) continue;
      for (const e of near) {
        const bw = bestMeleeWeapon(A, u, e);
        if (!bw) continue;
        const counter = bestMeleeWeapon(A, e, u);
        const val = damageValue(A, bw.dmg, e) - (counter ? counter.dmg * 0.5 : 0);
        if (!best || val > best.val) best = { path: p.path, target: e, weapon: bw.weapon, val };
      }
    }
    return best;
  }

  function bestFightNow(A, u) {
    let best = null;
    for (const e of A.fightCandidates(u)) {
      const bw = bestMeleeWeapon(A, u, e);
      if (!bw) continue;
      const val = damageValue(A, bw.dmg, e);
      if (!best || val > best.val) best = { target: e, weapon: bw.weapon, val };
    }
    return best;
  }

  // Best "move somewhere then shoot" plan.
  function bestMoveShoot(A, u, reach, maxIn) {
    const cands = moveCandidates(A, u, 'reposition', maxIn, reach);
    let best = null;
    for (const p of cands) {
      const ghost = { ...u, x: p.x, y: p.y };
      let localBest = null;
      for (const e of enemies(A, u.team)) {
        const env = A.KTR.shootEnv(A.mapDef(), A.state().combat.pieceState.open, ghost, e);
        if (!env.visible) continue;
        if (e.order === 'conceal' && env.inCover) continue;
        const bw = bestRangedWeapon(A, ghost, e, env.inCover);
        if (!bw) continue;
        const val = damageValue(A, bw.dmg, e);
        if (!localBest || val > localBest.val) localBest = { target: e, weapon: bw.weapon, val };
      }
      if (!localBest) continue;
      const score = localBest.val - exposureAt(A, u, p.x, p.y) * 0.8;
      if (!best || score > best.score) best = { path: p.path, ...localBest, score };
    }
    return best;
  }

  // Best objective move (reposition or dash toward the juiciest marker,
  // preferring low-exposure spots).
  function bestObjectiveMove(A, u, kind, reach, maxIn) {
    const map = A.mapDef();
    const cands = moveCandidates(A, u, kind, maxIn, reach);
    let best = null;
    for (const p of cands) {
      let score = 0;
      for (const obj of (map.objectives || [])) {
        const before = Math.hypot(obj.x - u.x, obj.y - u.y);
        const after = Math.hypot(obj.x - p.x, obj.y - p.y);
        const ov = objectiveValue(A, obj, u.team);
        score += (before - after) * 0.35 * ov;
        if (after < 1.2) score += 2.5 * ov;   // standing on it
      }
      score -= exposureAt(A, u, p.x, p.y) * 0.9;
      if (!best || score > best.score) best = { path: p.path, score };
    }
    return best;
  }

  // ── Turn driver ─────────────────────────────────────────────────────
  function tick() {
    const A = api();
    if (!A) return;
    const s = A.state();
    if (!s.aiTeam) { stop(); return; }
    if (busy) return;
    busy = true;
    try { step(A, s); }
    catch (e) { console.error('KT_AI error:', e); }
    finally { busy = false; }
  }

  function step(A, s) {
    const ai = s.aiTeam;

    // Initiative screen: if the AI won the roll, let the human deploy first
    // (the AI prefers reacting; the human takes TP1 initiative).
    if (s.phase === 'initiative' && s.initiative.winner === ai) {
      const btn = document.querySelector(`#initiative-choose [data-first="${ai === 'B' ? 'A' : 'B'}"]`);
      if (btn && btn.offsetParent !== null) btn.click();
      return;
    }

    // Deployment: place the pending unit.
    if (s.phase === 'deploy' && s.deploy.currentTeam === ai && s.deploy.pendingUnit) {
      deployOne(A, s, s.deploy.pendingUnit);
      return;
    }

    if (s.phase !== 'combat' || s.combat.over) return;

    // Open modals owned by the AI: commit them.
    if (s.combat.shoot && s.combat.shoot.attacker.team === ai) {
      if (s.combat.shoot.step === 'resolved') A.commitShoot();
      return;
    }
    if (s.combat.fight && s.combat.fight.attacker.team === ai) {
      const f = s.combat.fight;
      if (f.step === 'resolving' || f.step === 'rolled') A.commitFight();
      return;
    }
    // A human-owned dialog is open (their shoot/fight, or a Guard-interrupt
    // offer): wait rather than stomping their choice.
    if (s.combat.shoot || s.combat.fight) return;
    const picker = document.getElementById('target-picker');
    if (picker && picker.style.display !== 'none') return;

    // Counteract offer.
    if (s.combat.counteract && s.combat.counteract.selecting && s.combat.counteract.team === ai) {
      const cands = A.counteractCandidates(ai);
      if (!cands.length) { A.passCounteract(); return; }
      // Prefer a counteract shooter with a target; otherwise dash to an
      // objective; otherwise pass.
      for (const u of cands) {
        if (A.shootCandidates(u).length) { A.startCounteract(u); return; }
      }
      const mover = cands.find(u => bestObjectiveMove(A, u, 'dash', computeReach(A, u, 2), 2));
      if (mover) { A.startCounteract(mover); return; }
      A.passCounteract();
      return;
    }

    const act = A.activation();
    if (act && act.unit.team === ai) {
      runActivationStep(A, s, act);
      return;
    }

    // Our turn to pick an operative?
    if (!act && A.activeTeam() === ai && A.readyUnits(ai).length) {
      const pick = chooseNextOperative(A, s);
      if (pick) A.startActivation(pick);
    }
  }

  function deployOne(A, s, u) {
    const map = A.mapDef();
    const squares = window.KT.deploySquares(map, u.team);
    const zones = squares.length ? squares : [window.KT.deployZone(map, u.team)];
    // Prefer squares nearest the middle objective; jitter within.
    const objs = map.objectives || [];
    const center = objs.length
      ? objs.reduce((acc, o) => ({ x: acc.x + o.x / objs.length, y: acc.y + o.y / objs.length }), { x: 0, y: 0 })
      : { x: 14, y: 12 };
    const ranked = zones.slice().sort((a, b) => {
      const da = Math.hypot(a.x + a.w / 2 - center.x, a.y + a.h / 2 - center.y);
      const db = Math.hypot(b.x + b.w / 2 - center.x, b.y + b.h / 2 - center.y);
      return da - db;
    });
    for (const z of ranked) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const x = z.x + 0.8 + Math.random() * Math.max(0.2, z.w - 1.6);
        const y = z.y + 0.8 + Math.random() * Math.max(0.2, z.h - 1.6);
        if (A.validDeployPoint(u, x, y) && A.tryPlacePending(x, y)) return;
      }
    }
    // Fallback: coarse scan of the whole half.
    const zone = window.KT.deployZone(map, u.team);
    for (let x = zone.x + 1; x < zone.x + zone.w; x += 1.5) {
      for (let y = zone.y + 1; y < zone.y + zone.h; y += 1.5) {
        if (A.validDeployPoint(u, x, y) && A.tryPlacePending(x, y)) return;
      }
    }
  }

  // Which ready operative acts next: melee threats already in range first,
  // then shooters with targets, then the rest.
  function chooseNextOperative(A, s) {
    const ready = A.readyUnits(s.aiTeam);
    let best = null, bestScore = -Infinity;
    for (const u of ready) {
      let score = 0;
      if (A.fightCandidates(u).length) score += 6;
      if (A.shootCandidates(u).length) score += 4;
      if (A.KTR.isInjured(u)) score += 1;   // act before it gets worse
      if (!best || score > bestScore) { best = u; bestScore = score; }
    }
    return best;
  }

  // Collect the scored plan list for the current activation (also exposed
  // via KT_AI.plans() for debugging).
  function collectPlans(A, s, act) {
    const u = act.unit;
    const plans = [];
    const effMove = A.KTR.effectiveMove(u);
    const cap = act.counteract ? 2 : Infinity;
    const budgetRepo = Math.min(effMove, cap);
    const budgetDash = Math.min(3, cap);
    const budgetCharge = Math.min(effMove + 2, cap);
    const reach = computeReach(A, u, Math.max(budgetRepo, budgetDash, budgetCharge));
    if (act.ap >= 1 && !act.hasShot) {
      const shootNow = bestShootNow(A, u);
      if (shootNow) plans.push({ kind: 'shootNow', val: shootNow.val + 0.5, run: () => {
        ensureOrder(A, act, 'engage');
        return A.doShoot(shootNow.target, shootNow.weapon.name);
      } });
    }
    if (act.ap >= 2 && !act.hasShot && !act.hasReposition) {
      const ms = bestMoveShoot(A, u, reach, budgetRepo);
      if (ms) plans.push({ kind: 'moveShoot', val: ms.score, run: () => {
        ensureOrder(A, act, 'engage');
        return A.doMove('reposition', ms.path);
      } });
    }
    if (act.ap >= 2 && !act.hasFought) {
      const cf = bestChargeFight(A, u, reach, budgetCharge);
      if (cf) plans.push({ kind: 'charge', val: cf.val + 1, run: () => {
        ensureOrder(A, act, 'engage');
        return A.doMove('charge', cf.path);
      } });
    }
    // Mission actions (Secure / Loot / Transmission / Plant Device).
    const mas = A.missionActionsFor(u, act).filter(m => !m.reason && m.id !== 'ma-scout');
    if (act.ap >= 1 && mas.length) {
      plans.push({ kind: 'mission', val: 5.5, run: () => { A.performMissionAction(mas[0]); return true; } });
    }
    // Open a nearby closed hatchway — it unlocks routes for the whole team.
    if (act.ap >= 1 && !A.KTR.inEnemyControlRange(u, s.units)) {
      const hatch = A.nearestOpenable(u, 'hatchway');
      if (hatch && !A.isPieceOpen(hatch.pieceIndex)) {
        plans.push({ kind: 'openHatch', val: 2.6, run: () => {
          const before = act.ap;
          A.performOpenHatchway();
          return A.activation() === act && act.ap < before;
        } });
      }
    }
    // Objective movement.
    if (act.ap >= 1 && !act.hasReposition) {
      const om = bestObjectiveMove(A, u, 'reposition', reach, budgetRepo);
      if (om && om.score > 0.3) plans.push({ kind: 'moveObj', val: om.score, run: () => A.doMove('reposition', om.path) });
    }
    if (act.ap >= 1 && !act.hasDashed && !act.hasCharged) {
      const od = bestObjectiveMove(A, u, 'dash', reach, budgetDash);
      if (od && od.score > 0.3) plans.push({ kind: 'dashObj', val: od.score - 0.4, run: () => A.doMove('dash', od.path) });
    }
    // Fall back out of a losing melee.
    if (act.ap >= 2 && A.KTR.inEnemyControlRange(u, s.units) && A.KTR.isInjured(u)) {
      const fb = bestObjectiveMove(A, u, 'fallBack', reach, budgetRepo);
      if (fb) plans.push({ kind: 'fallBack', val: 3, run: () => A.doMove('fallBack', fb.path) });
    }
    plans.sort((a, b) => b.val - a.val);
    return plans;
  }

  // One planning/execution step inside the AI's own activation. Called
  // repeatedly (each tick) until AP runs out, then ends the activation.
  function runActivationStep(A, s, act) {
    const u = act.unit;

    // Already in melee? Fight if we can.
    if (act.ap >= 1 && !act.hasFought) {
      const fightNow = bestFightNow(A, u);
      if (fightNow && A.KTR.inEnemyControlRange(u, s.units)) {
        ensureOrder(A, act, 'engage');
        if (A.doFight(fightNow.target, fightNow.weapon.name)) return;
      }
    }

    const plans = collectPlans(A, s, act);
    for (const p of plans) {
      if (p.run()) return;
    }

    // Nothing worth doing (or everything failed): default order + end.
    if (!act.history.length && !act.counteract) {
      // Never acted: conceal if we're a bystander this turn.
      ensureOrder(A, act, 'conceal');
    }
    A.endActivation();
  }

  function ensureOrder(A, act, order) {
    if (act.counteract) return;
    if (act.history.length === 0 && act.order !== order) A.pickOrder(order);
  }

  root.KT_AI = {
    poke() { start(); },
    stop,
    // Debug: score the current activation's plans without executing them.
    plans() {
      const A = api();
      const act = A.activation();
      if (!act) return [];
      return collectPlans(A, A.state(), act).map(p => ({ kind: p.kind, val: p.val }));
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
