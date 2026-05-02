// Pure Kill Team rule logic. Has no DOM dependencies; consumed by game.js.
//
// All distances are in inches; the rest of the game treats the 28×24 Tomb-
// World board the same way.
//
// We cover the chunks of the core rules the game currently exercises:
//   * Engage / Conceal orders
//   * Cover (light / full) and visibility
//   * Engagement range (1")
//   * Action validation (Reposition / Dash / Charge / Fall Back)
//   * Shooting and Fighting dice math, including optimal save allocation
//
// Faction rules, ploys, and equipment are intentionally skipped; weapon
// special rules we recognise are listed in WEAPON_RULES below.

(function (root) {
  const KT_RULES = root.KT_RULES = root.KT_RULES || {};

  // ── Constants ───────────────────────────────────────────────────────
  const ENGAGEMENT_RANGE = 1.0;            // "control range" — measured base-edge to base-edge
  const MM_PER_INCH = 25.4;
  const DEFAULT_BASE_MM = 28;
  const COVER_FAR_THRESHOLD = 2.0;          // cover only counts if >2" from shooter
  const VANTAGE_HEIGHT_THRESHOLD = 2.0;
  const DASH_INCHES = 3;
  const CHARGE_BONUS = 2;                   // M+2"
  const FALL_BACK_AP = 2;
  const REPOSITION_AP = 1;
  const DASH_AP = 1;
  const CHARGE_AP = 1;
  const SHOOT_AP = 1;
  const FIGHT_AP = 1;
  const OPEN_HATCH_AP = 1;
  const BREACH_AP = 2;
  const BREACH_AP_GRENADIER = 1;

  KT_RULES.constants = {
    ENGAGEMENT_RANGE,
    COVER_FAR_THRESHOLD,
    VANTAGE_HEIGHT_THRESHOLD,
    DASH_INCHES,
    CHARGE_BONUS,
    REPOSITION_AP,
    DASH_AP,
    CHARGE_AP,
    FALL_BACK_AP,
    SHOOT_AP,
    FIGHT_AP,
    OPEN_HATCH_AP,
    BREACH_AP,
    BREACH_AP_GRENADIER,
  };

  // ── Dice ────────────────────────────────────────────────────────────
  function rollD6() { return 1 + Math.floor(Math.random() * 6); }

  // Roll attack dice. Each roll: >=critAt => critical; >=hit (and < critAt)
  // => normal; else fail. autoCrits/autoNormals are pre-retained successes
  // (Accurate, Vantage, etc.).
  function rollAttack(atkDice, hit, critAt, autoCrits, autoNormals) {
    if (critAt == null) critAt = 6;
    autoCrits = autoCrits || 0;
    autoNormals = autoNormals || 0;
    const rolls = [];
    let n = autoNormals, c = autoCrits, f = 0;
    for (let i = 0; i < atkDice; i++) {
      const r = rollD6();
      rolls.push(r);
      if (r >= critAt) c++;
      else if (r >= hit) n++;
      else f++;
    }
    return { rolls, normals: n, criticals: c, fails: f };
  }

  // Roll defence dice. 6 always crit-success, 1 always fail. autoNormals are
  // pre-retained (cover save, etc.); they are not actually rolled.
  function rollDefence(defDice, save, autoNormals) {
    autoNormals = autoNormals || 0;
    const rolls = [];
    let n = autoNormals, c = 0, f = 0;
    for (let i = 0; i < defDice; i++) {
      const r = rollD6();
      rolls.push(r);
      if (r === 6) c++;
      else if (r >= save) n++;
      else f++;
    }
    return { rolls, normals: n, criticals: c, fails: f };
  }

  // ── Optimal save allocation ─────────────────────────────────────────
  // Adapted from ballistica-imperialis (the user's other project).
  // Brutal forces normal saves to be discarded entirely.
  function allocateSavesOptimally(atkN, atkC, defN, defC, nDmg, cDmg, brutal) {
    const effDefN = brutal ? 0 : defN;
    let bestRemN = atkN, bestRemC = atkC;
    let bestDmg = atkN * nDmg + atkC * cDmg;
    const maxC2C = Math.min(defC, atkC);
    for (let c2c = 0; c2c <= maxC2C; c2c++) {
      const remCS = defC - c2c;
      for (let c2p = 0; c2p <= remCS; c2p++) {
        if (2 * c2p > atkN) continue;
        const savesLeft = remCS - c2p;
        const afterPairs = atkN - 2 * c2p;
        const maxC2N = Math.min(savesLeft, afterPairs);
        for (let c2n = 0; c2n <= maxC2N; c2n++) {
          const afterCritSolos = afterPairs - c2n;
          const maxN2N = Math.min(effDefN, afterCritSolos);
          for (let n2n = 0; n2n <= maxN2N; n2n++) {
            const remN = afterCritSolos - n2n;
            const remC = atkC - c2c;
            const dmg = remN * nDmg + remC * cDmg;
            if (dmg < bestDmg) { bestDmg = dmg; bestRemN = remN; bestRemC = remC; }
          }
        }
      }
    }
    return { remN: bestRemN, remC: bestRemC, damage: bestDmg };
  }

  // ── Weapon rule parsing ─────────────────────────────────────────────
  // Recognised: Range X", Lethal X+, Piercing X, Piercing Crits X, Rending,
  // Punishing, Severe, Saturate, Brutal, Devastating X, Accurate X, Hot.
  function parseWeaponRules(rules) {
    const out = [];
    for (const raw of (rules || [])) {
      const r = String(raw).trim();
      // Range X"
      let m = r.match(/^Range\s+(\d+)\"?$/i);
      if (m) { out.push({ name: 'Range', value: +m[1], raw: r }); continue; }
      // Lethal X+
      m = r.match(/^Lethal\s+(\d+)\+?$/i);
      if (m) { out.push({ name: 'Lethal', value: +m[1], raw: r }); continue; }
      // Piercing Crits X
      m = r.match(/^Piercing Crits\s+(\d+)$/i);
      if (m) { out.push({ name: 'Piercing Crits', value: +m[1], raw: r }); continue; }
      // Piercing X
      m = r.match(/^Piercing\s+(\d+)$/i);
      if (m) { out.push({ name: 'Piercing', value: +m[1], raw: r }); continue; }
      // Devastating X
      m = r.match(/^Devastating\s+(\d+)$/i);
      if (m) { out.push({ name: 'Devastating', value: +m[1], raw: r }); continue; }
      // Accurate X
      m = r.match(/^Accurate\s+(\d+)$/i);
      if (m) { out.push({ name: 'Accurate', value: +m[1], raw: r }); continue; }
      // MWx (mortal wounds)
      m = r.match(/^MW\s*(\d+)$/i);
      if (m) { out.push({ name: 'MW', value: +m[1], raw: r }); continue; }
      // Plain keywords: Rending, Punishing, Severe, Saturate, Brutal, Hot, Splash X (ignore)
      m = r.match(/^(Rending|Punishing|Severe|Saturate|Brutal|Hot|Stun|Shock|Blast|Torrent|Indirect|Heavy|Silent|Limited)\b/i);
      if (m) { out.push({ name: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(), value: null, raw: r }); continue; }
      out.push({ name: '_unknown', value: null, raw: r });
    }
    return out;
  }
  function ruleByName(parsed, name) {
    return parsed.find(p => p.name.toLowerCase() === name.toLowerCase());
  }
  function hasRule(parsed, name) { return !!ruleByName(parsed, name); }

  function weaponRange(weapon) {
    const parsed = weapon._parsedRules || (weapon._parsedRules = parseWeaponRules(weapon.rules));
    const r = ruleByName(parsed, 'Range');
    return r ? r.value : Infinity;
  }

  // ── Operative keyword helpers ───────────────────────────────────────
  function isGrenadier(operativeOrUnit) {
    if (!operativeOrUnit) return false;
    const fields = [
      operativeOrUnit.name,
      operativeOrUnit.full_name,
      operativeOrUnit.fullName,
      operativeOrUnit._displayName,
    ].filter(Boolean).map(s => String(s).toUpperCase());
    return fields.some(s => /(GRENADIER|BREACHER|MINER)/.test(s));
  }
  KT_RULES.isGrenadier = isGrenadier;

  // Operative parses M stat as a string like '6"' or just '6'.
  function parseMoveStat(m) {
    if (m == null) return 6;
    const s = String(m).match(/(\d+(?:\.\d+)?)/);
    return s ? +s[1] : 6;
  }
  KT_RULES.parseMoveStat = parseMoveStat;

  // ── Geometry helpers (shared with maps-data.js) ─────────────────────
  function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }
  function pointSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function segIntersect(a, b, c, d) {
    const den = (d.y - c.y) * (b.x - a.x) - (d.x - c.x) * (b.y - a.y);
    if (Math.abs(den) < 1e-9) return false;
    const ua = ((d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x)) / den;
    const ub = ((b.x - a.x) * (a.y - c.y) - (b.y - a.y) * (a.x - c.x)) / den;
    const eps = 1e-6;
    return ua > eps && ua < 1 - eps && ub > eps && ub < 1 - eps;
  }
  // Inclusive intersection — true if segments touch at endpoints too. Used by
  // segment-to-segment distance.
  function segIntersectInclusive(a, b, c, d) {
    const den = (d.y - c.y) * (b.x - a.x) - (d.x - c.x) * (b.y - a.y);
    if (Math.abs(den) < 1e-9) return false;
    const ua = ((d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x)) / den;
    const ub = ((b.x - a.x) * (a.y - c.y) - (b.y - a.y) * (a.x - c.x)) / den;
    return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
  }
  // Minimum distance between two segments. Returns 0 if they touch / cross.
  function segSegDist(x1, y1, x2, y2, x3, y3, x4, y4) {
    const a = { x: x1, y: y1 }, b = { x: x2, y: y2 };
    const c = { x: x3, y: y3 }, d = { x: x4, y: y4 };
    if (segIntersectInclusive(a, b, c, d)) return 0;
    return Math.min(
      pointSegDist(x1, y1, x3, y3, x4, y4),
      pointSegDist(x2, y2, x3, y3, x4, y4),
      pointSegDist(x3, y3, x1, y1, x2, y2),
      pointSegDist(x4, y4, x1, y1, x2, y2),
    );
  }

  // ── Operative base helpers ─────────────────────────────────────────
  // Operatives carry `base` (mm) — round bases as { d } and oval bases as
  // { w, h }. Engagement range is measured base-edge to base-edge, and wall
  // collision must respect the full footprint. We use the *max* axis as a
  // conservative circular envelope for ovals (we render them long-axis-
  // horizontal regardless of facing).
  function unitBaseRadius(unit) {
    const b = unit && unit.base;
    if (!b) return (DEFAULT_BASE_MM / 2) / MM_PER_INCH;
    if (b.d != null) return (b.d / 2) / MM_PER_INCH;
    if (b.w != null && b.h != null) return Math.max(b.w, b.h) / 2 / MM_PER_INCH;
    return (DEFAULT_BASE_MM / 2) / MM_PER_INCH;
  }
  KT_RULES.unitBaseRadius = unitBaseRadius;

  // Edge-to-edge distance between two operatives (or 0 if their bases overlap).
  function edgeDist(a, b) {
    return Math.max(0, dist(a.x, a.y, b.x, b.y) - unitBaseRadius(a) - unitBaseRadius(b));
  }
  KT_RULES.edgeDist = edgeDist;

  // Edge-to-point distance between an operative and a fixed point (objective,
  // hatch midpoint, etc.). Negative is clamped to 0.
  function edgeDistToPoint(unit, px, py) {
    return Math.max(0, dist(unit.x, unit.y, px, py) - unitBaseRadius(unit));
  }
  KT_RULES.edgeDistToPoint = edgeDistToPoint;

  // Effective walls for the current piece state. Each compiled wall carries
  // an optional `pieceIndex`; if that piece is currently open we drop the
  // wall segment from the set used for movement / LoS.
  function effectiveWalls(map, openPieces) {
    if (!map || !map.walls) return [];
    if (!openPieces || openPieces.size === 0) return map.walls;
    return map.walls.filter(w => w.pieceIndex == null || !openPieces.has(w.pieceIndex));
  }
  KT_RULES.effectiveWalls = effectiveWalls;

  // Does the segment p1..p2 cross any (non-open) wall?
  function losBlockedByWalls(map, openPieces, x1, y1, x2, y2) {
    const a = { x: x1, y: y1 }, b = { x: x2, y: y2 };
    for (const w of effectiveWalls(map, openPieces)) {
      if (segIntersect(a, b, { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) return true;
    }
    return false;
  }
  KT_RULES.losBlockedByWalls = losBlockedByWalls;

  // Does the swept base of radius `r` along p1..p2 overlap any (non-open)
  // wall? A leg is illegal if the operative's base would intersect a wall
  // anywhere along the path — including at the endpoint. Equivalent to
  // segment-to-segment distance < r.
  function moveBlockedByWalls(map, openPieces, x1, y1, x2, y2, r) {
    if (r == null) r = 0;
    const eps = 1e-6;
    for (const w of effectiveWalls(map, openPieces)) {
      const d = segSegDist(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2);
      if (d < r - eps) return true;
    }
    return false;
  }
  KT_RULES.moveBlockedByWalls = moveBlockedByWalls;

  // ── Cover / visibility ──────────────────────────────────────────────
  // Tomb World: walls = full cover (block LoS); debris (C1-C5), barricade,
  // sarcophagus = light cover. Teleport pads / circles do not give cover.
  function lightCoverPieces(map) {
    const out = [];
    for (const t of (map.terrain || [])) {
      const kind = t.cover || (t.type === 'square' ? 'light'
        : t.type === 'sarcophagus' ? 'light'
        : t.type === 'rect' ? 'light'
        : t.type === 'octagon' ? 'light'
        : t.type === 'barricade' ? 'light'
        : null);
      if (kind === 'light' || kind === 'debris' || kind === 'heavy') {
        out.push(t);
      }
    }
    return out;
  }
  function terrainRadius(t) {
    if (t.r != null) return t.r;
    if (t.size != null) return t.size * 0.5;
    if (t.w != null && t.h != null) return Math.max(t.w, t.h) * 0.5;
    return 1.0;
  }

  // Check if a piece of light terrain intervenes between attacker and target,
  // and is >2" from attacker (cover requirement).
  function lightCoverIntervening(map, ax, ay, dx, dy) {
    for (const t of lightCoverPieces(map)) {
      const r = terrainRadius(t) * 0.85; // small relaxation so ovals catch
      const distFromShooter = Math.hypot(t.x - ax, t.y - ay);
      if (distFromShooter <= COVER_FAR_THRESHOLD) continue;
      const distToTarget = Math.hypot(t.x - dx, t.y - dy);
      // require terrain to be nearer the target side than the shooter
      if (distFromShooter < distToTarget) continue;
      const d = pointSegDist(t.x, t.y, ax, ay, dx, dy);
      if (d <= r) return true;
    }
    return false;
  }
  KT_RULES.lightCoverIntervening = lightCoverIntervening;

  // Resolve a shooting environment: visible (LoS), in cover (light), and
  // whether attacker is within 2" of any cover piece (which negates cover).
  function shootEnv(map, openPieces, attacker, target) {
    const visible = !losBlockedByWalls(map, openPieces, attacker.x, attacker.y, target.x, target.y);
    const inCover = visible && lightCoverIntervening(map, attacker.x, attacker.y, target.x, target.y);
    return { visible, inCover };
  }
  KT_RULES.shootEnv = shootEnv;

  // ── Action validation ──────────────────────────────────────────────
  // Returns null if valid; otherwise reason string.
  // Engagement / control range is measured BASE-EDGE to BASE-EDGE: an enemy
  // is in control range when the gap between their two bases is ≤ 1".
  function controlRangeOf(unit, units) {
    const eps = 1e-3;
    const rU = unitBaseRadius(unit);
    return units.filter(o => o.alive && o.deployed && o.team !== unit.team
      && Math.hypot(o.x - unit.x, o.y - unit.y) - rU - unitBaseRadius(o) <= ENGAGEMENT_RANGE + eps);
  }
  KT_RULES.controlRangeOf = controlRangeOf;
  function inEnemyControlRange(unit, units) {
    return controlRangeOf(unit, units).length > 0;
  }
  KT_RULES.inEnemyControlRange = inEnemyControlRange;
  // Same edge-to-edge test against a hypothetical position (x, y) for `unit`
  // — used by movement validation when the unit hasn't yet committed.
  function inEnemyControlRangeAt(unit, units, x, y) {
    const eps = 1e-3;
    const rU = unitBaseRadius(unit);
    return units.some(o => o.alive && o.deployed && o.team !== unit.team
      && Math.hypot(o.x - x, o.y - y) - rU - unitBaseRadius(o) <= ENGAGEMENT_RANGE + eps);
  }
  KT_RULES.inEnemyControlRangeAt = inEnemyControlRangeAt;

  function validateReposition(unit, activation) {
    if (activation.hasCharged) return 'Cannot Reposition after Charge.';
    if (activation.hasFallenBack) return 'Cannot Reposition after Fall Back.';
    if (activation.hasReposition) return 'Already Repositioned this activation.';
    if (activation.ap < REPOSITION_AP) return 'Not enough AP.';
    return null;
  }
  function validateDash(unit, activation) {
    if (activation.hasCharged) return 'Cannot Dash after Charge.';
    if (activation.hasDashed) return 'Already Dashed this activation.';
    if (activation.ap < DASH_AP) return 'Not enough AP.';
    return null;
  }
  function validateCharge(unit, activation, units) {
    if (activation.order !== 'engage') return 'Charge requires the Engage order.';
    if (activation.hasReposition) return 'Cannot Charge after Reposition.';
    if (activation.hasDashed) return 'Cannot Charge after Dash.';
    if (activation.hasFallenBack) return 'Cannot Charge after Fall Back.';
    if (activation.hasCharged) return 'Already Charged this activation.';
    if (inEnemyControlRange(unit, units)) return 'Cannot Charge while in enemy control range.';
    if (activation.ap < CHARGE_AP) return 'Not enough AP.';
    return null;
  }
  function validateFallBack(unit, activation, units) {
    if (activation.hasReposition) return 'Cannot Fall Back after Reposition.';
    if (activation.hasCharged) return 'Cannot Fall Back after Charge.';
    if (activation.hasFallenBack) return 'Already Fell Back this activation.';
    if (!inEnemyControlRange(unit, units)) return 'Fall Back requires enemy in control range.';
    if (activation.ap < FALL_BACK_AP) return 'Not enough AP.';
    return null;
  }
  function validateShoot(unit, activation, units) {
    if (activation.order !== 'engage') return 'Shoot requires the Engage order.';
    if (inEnemyControlRange(unit, units)) return 'Cannot Shoot while in enemy control range.';
    if (activation.ap < SHOOT_AP) return 'Not enough AP.';
    if (!unit.weapons || !unit.weapons.some(w => !w.is_melee)) return 'No ranged weapon.';
    return null;
  }
  function validateFight(unit, activation, units) {
    if (!inEnemyControlRange(unit, units)) return 'Fight requires enemy in control range.';
    if (activation.ap < FIGHT_AP) return 'Not enough AP.';
    if (!unit.weapons || !unit.weapons.some(w => w.is_melee)) return 'No melee weapon.';
    return null;
  }
  function validateOpenHatchway(unit, activation) {
    if (activation.ap < OPEN_HATCH_AP) return 'Not enough AP.';
    return null;
  }
  function validateBreach(unit, activation) {
    const cost = isGrenadier(unit) ? BREACH_AP_GRENADIER : BREACH_AP;
    if (activation.ap < cost) return 'Not enough AP for Breach (' + cost + ').';
    return null;
  }
  KT_RULES.validate = {
    reposition: validateReposition,
    dash: validateDash,
    charge: validateCharge,
    fallBack: validateFallBack,
    shoot: validateShoot,
    fight: validateFight,
    openHatchway: validateOpenHatchway,
    breach: validateBreach,
  };

  function breachAPCost(unit) {
    return isGrenadier(unit) ? BREACH_AP_GRENADIER : BREACH_AP;
  }
  KT_RULES.breachAPCost = breachAPCost;

  // ── Shoot resolution helper ────────────────────────────────────────
  // Resolves a shooting attack to its damage value given attacker dice,
  // defender dice, and weapon stats. Used in shooting modal.
  function resolveShootDamage({
    weapon, atkN, atkC, defN, defC,
    devastating, lethalCritDice,
    severe, rending, punishing, atkF,
  }) {
    let n = atkN, c = atkC, f = atkF || 0;
    if (severe && c === 0 && n > 0) { n--; c++; }
    if (rending && c > 0 && n > 0) { n--; c++; }
    if (punishing && c > 0 && f > 0) { f--; n++; }

    let dmg = 0;
    let damCritDice = 0;
    if (devastating != null && c > 0) { dmg += c * devastating; damCritDice = c; }

    const brutal = weapon._parsedRules && hasRule(weapon._parsedRules, 'Brutal');
    const alloc = allocateSavesOptimally(n, c, defN, defC, weapon.normal_dmg, weapon.crit_dmg, brutal);
    const remN = alloc.remN;
    const remC = alloc.remC;
    dmg += remN * weapon.normal_dmg + remC * weapon.crit_dmg;
    return { dmg, remN, remC, postFixN: n, postFixC: c };
  }
  KT_RULES.resolveShootDamage = resolveShootDamage;

  // ── Apply weapon special rules to attack-dice categorisation ───────
  // Returns mutated counts after Severe/Rending/Punishing fixups.
  function applyAttackFixups(parsed, atkN, atkC, atkF) {
    if (hasRule(parsed, 'Severe') && atkC === 0 && atkN > 0) { atkN--; atkC++; }
    if (hasRule(parsed, 'Rending') && atkC > 0 && atkN > 0) { atkN--; atkC++; }
    if (hasRule(parsed, 'Punishing') && atkC > 0 && atkF > 0) { atkF--; atkN++; }
    return { atkN, atkC, atkF };
  }
  KT_RULES.applyAttackFixups = applyAttackFixups;

  function defenceDiceCount(parsed, inCover) {
    // Saturate means cover does not retain a save; otherwise cover saves
    // replace one rolled die.
    const saturate = hasRule(parsed, 'Saturate');
    let dice = 3;
    let autoNormals = 0;
    if (inCover && !saturate) { dice = 2; autoNormals = 1; }
    return { dice, autoNormals };
  }
  KT_RULES.defenceDiceCount = defenceDiceCount;

  function effectiveSave(target, parsed) {
    let save = target.save;
    const piercing = ruleByName(parsed, 'Piercing');
    if (piercing) save = Math.min(6, save + piercing.value);
    return save;
  }
  KT_RULES.effectiveSave = effectiveSave;

  // ── Fight helpers ──────────────────────────────────────────────────
  // Both operatives are rolled with their melee weapon's Atk/Hit (crit on 6).
  // Attacker resolves first, then defender, alternating until one side has
  // no unresolved successes.
  function fightDicePool(weapon) { return weapon.atk; }
  KT_RULES.fightDicePool = fightDicePool;

  // ── Wound thresholds ───────────────────────────────────────────────
  // Operative is wounded (and gets -1 Hit, -2" Move) at < ceil(W/2) wounds.
  function isInjured(unit) {
    return unit.alive && unit.hp <= Math.ceil(unit.maxHp / 2) - 1;
  }
  KT_RULES.isInjured = isInjured;

  // ── Misc UI helpers ───────────────────────────────────────────────
  function rangeFromInches(weapon) {
    const r = weaponRange(weapon);
    return r === Infinity ? '∞' : r + '"';
  }
  KT_RULES.rangeFromInches = rangeFromInches;

  KT_RULES.rollD6 = rollD6;
  KT_RULES.rollAttack = rollAttack;
  KT_RULES.rollDefence = rollDefence;
  KT_RULES.allocateSavesOptimally = allocateSavesOptimally;
  KT_RULES.parseWeaponRules = parseWeaponRules;
  KT_RULES.ruleByName = ruleByName;
  KT_RULES.hasRule = hasRule;
  KT_RULES.weaponRange = weaponRange;
  KT_RULES.dist = dist;
  KT_RULES.pointSegDist = pointSegDist;
  KT_RULES.segIntersect = segIntersect;
})(window);
