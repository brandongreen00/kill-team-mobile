// Unit tests for rules.js — the pure rule layer used by game.js. These tests
// exercise dice math, weapon-rule parsing, save allocation, geometry / LoS,
// cover, and action validation. All numbers are in inches.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./load');

const env = setup();
const R = env.KT_RULES;
const KT = env.KT;

// ── Constants ─────────────────────────────────────────────────────────────
test('constants are wired through', () => {
  const c = R.constants;
  assert.equal(c.ENGAGEMENT_RANGE, 1.0);
  assert.equal(c.DASH_INCHES, 3);
  assert.equal(c.CHARGE_BONUS, 2);
  assert.equal(c.REPOSITION_AP, 1);
  assert.equal(c.FALL_BACK_AP, 2);
  assert.equal(c.BREACH_AP, 2);
  assert.equal(c.BREACH_AP_GRENADIER, 1);
});

// ── Dice ──────────────────────────────────────────────────────────────────
test('rollD6 always returns 1..6', () => {
  const restore = env.seedRandom(1);
  try {
    for (let i = 0; i < 5000; i++) {
      const r = R.rollD6();
      assert.ok(r >= 1 && r <= 6 && Number.isInteger(r));
    }
  } finally { restore(); }
});

test('rollAttack categorises rolls into normals / criticals / fails', () => {
  // Force every die to roll 6 → all crits (default critAt=6).
  let restore = env.sequenceRandom([6, 6, 6, 6]);
  try {
    const r = R.rollAttack(4, 3);
    assert.equal(r.criticals, 4);
    assert.equal(r.normals, 0);
    assert.equal(r.fails, 0);
  } finally { restore(); }

  // All 1s → all fails. Add 1 autoCrit and 2 autoNormals which must be
  // counted on top.
  restore = env.sequenceRandom([1, 1, 1]);
  try {
    const r = R.rollAttack(3, 3, 6, 1, 2);
    assert.equal(r.criticals, 1);
    assert.equal(r.normals, 2);
    assert.equal(r.fails, 3);
  } finally { restore(); }

  // hit=4: 1,2,3 fail; 4,5 normal; 6 crit.
  restore = env.sequenceRandom([1, 4, 5, 6]);
  try {
    const r = R.rollAttack(4, 4);
    assert.equal(r.fails, 1);
    assert.equal(r.normals, 2);
    assert.equal(r.criticals, 1);
  } finally { restore(); }
});

test('rollDefence treats 6 as crit and 1 as fail regardless of save', () => {
  const restore = env.sequenceRandom([1, 5, 6]);
  try {
    const r = R.rollDefence(3, 4);
    assert.equal(r.fails, 1);    // 1
    assert.equal(r.normals, 1);  // 5 vs save 4
    assert.equal(r.criticals, 1); // 6
  } finally { restore(); }
});

test('rollDefence respects autoNormals from cover', () => {
  const restore = env.sequenceRandom([2]); // single rolled fail
  try {
    const r = R.rollDefence(1, 4, 1);
    assert.equal(r.normals, 1);  // the cover save
    assert.equal(r.fails, 1);
  } finally { restore(); }
});

// ── Save allocation ───────────────────────────────────────────────────────
test('allocateSavesOptimally: crit-vs-crit cancels first', () => {
  // 0 normal hits, 2 crit hits dealing 4 dmg each. Defender has 2 crits +
  // 0 normals. Optimal allocation pairs them 1:1 and the attacker scores 0.
  const out = R.allocateSavesOptimally(0, 2, 0, 2, 3, 4, false);
  assert.equal(out.damage, 0);
  assert.equal(out.remN, 0);
  assert.equal(out.remC, 0);
});

test('allocateSavesOptimally: 2 crit-saves cancel one crit-hit when better', () => {
  // 0 N, 2 C @ crit_dmg=6. Defender has 2 N, 4 C. Best: 4 crits absorb 2
  // crit-hits → 0 dmg. Without the pair-cancel rule we'd lose 2*6 = 12.
  const out = R.allocateSavesOptimally(0, 2, 2, 4, 3, 6, false);
  assert.equal(out.damage, 0);
});

test('allocateSavesOptimally: brutal disables normal-save dice', () => {
  // 2 N, 0 C; defender has 3 N, 0 C. Without brutal the 3 N saves cancel
  // both normals (damage 0). With brutal those N saves don't apply, so 2 N
  // hits at 3 dmg each get through.
  const without = R.allocateSavesOptimally(2, 0, 3, 0, 3, 5, false);
  const with_   = R.allocateSavesOptimally(2, 0, 3, 0, 3, 5, true);
  assert.equal(without.damage, 0);
  assert.equal(with_.damage, 6);
});

test('allocateSavesOptimally: returns max damage when no saves', () => {
  const out = R.allocateSavesOptimally(2, 1, 0, 0, 3, 4, false);
  assert.equal(out.damage, 2 * 3 + 1 * 4);
  assert.equal(out.remN, 2);
  assert.equal(out.remC, 1);
});

// ── Weapon rule parsing ───────────────────────────────────────────────────
test('parseWeaponRules recognises Range / Lethal / Piercing variants', () => {
  const parsed = R.parseWeaponRules([
    'Range 8"', 'Lethal 5+', 'Piercing 1', 'Piercing Crits 1', 'Devastating 3',
    'Accurate 1', 'Rending', 'Brutal', 'Saturate', 'MW3',
  ]);
  const byName = (n) => parsed.find(p => p.name === n);
  assert.equal(byName('Range').value, 8);
  assert.equal(byName('Lethal').value, 5);
  assert.equal(byName('Piercing').value, 1);
  assert.equal(byName('Piercing Crits').value, 1);
  assert.equal(byName('Devastating').value, 3);
  assert.equal(byName('Accurate').value, 1);
  assert.ok(byName('Rending'));
  assert.ok(byName('Brutal'));
  assert.ok(byName('Saturate'));
  assert.equal(byName('MW').value, 3);
});

test('weaponRange returns Infinity when no Range rule present', () => {
  assert.equal(R.weaponRange({ rules: ['Lethal 5+'] }), Infinity);
  assert.equal(R.weaponRange({ rules: ['Range 6"'] }), 6);
});

test('hasRule / ruleByName are case-insensitive', () => {
  const p = R.parseWeaponRules(['Brutal']);
  assert.ok(R.hasRule(p, 'brutal'));
  assert.ok(R.hasRule(p, 'BRUTAL'));
  assert.equal(R.ruleByName(p, 'brutal').name, 'Brutal');
});

test('applyAttackFixups: severe upgrades a normal to crit when no crits', () => {
  const parsed = R.parseWeaponRules(['Severe']);
  const out = R.applyAttackFixups(parsed, 2, 0, 1);
  assert.equal(out.atkN, 1);
  assert.equal(out.atkC, 1);
});

test('applyAttackFixups: rending promotes a normal to crit when crits present', () => {
  const parsed = R.parseWeaponRules(['Rending']);
  const out = R.applyAttackFixups(parsed, 2, 1, 0);
  assert.equal(out.atkN, 1);
  assert.equal(out.atkC, 2);
});

test('applyAttackFixups: punishing converts a fail to a normal when crits present', () => {
  const parsed = R.parseWeaponRules(['Punishing']);
  const out = R.applyAttackFixups(parsed, 1, 1, 1);
  assert.equal(out.atkN, 2);
  assert.equal(out.atkF, 0);
});

// ── Defence dice / save ──────────────────────────────────────────────────
test('defenceDiceCount: cover swaps a die for an autoNormal', () => {
  const noCover = R.defenceDiceCount(R.parseWeaponRules([]), false);
  const inCover = R.defenceDiceCount(R.parseWeaponRules([]), true);
  assert.deepEqual(noCover, { dice: 3, autoNormals: 0 });
  assert.deepEqual(inCover, { dice: 2, autoNormals: 1 });
});

test('defenceDiceCount: Saturate ignores cover', () => {
  const parsed = R.parseWeaponRules(['Saturate']);
  const inCover = R.defenceDiceCount(parsed, true);
  assert.deepEqual(inCover, { dice: 3, autoNormals: 0 });
});

test('effectiveSave: Piercing X worsens save by X (capped at 6+)', () => {
  const target = { save: 4 };
  assert.equal(R.effectiveSave(target, R.parseWeaponRules(['Piercing 1'])), 5);
  assert.equal(R.effectiveSave(target, R.parseWeaponRules(['Piercing 5'])), 6);
});

// ── Geometry / base helpers ──────────────────────────────────────────────
test('unitBaseRadius converts mm bases to inches', () => {
  // 32mm round → 16mm radius → 16/25.4 ≈ 0.6299"
  assert.ok(Math.abs(R.unitBaseRadius({ base: { d: 32 } }) - 32 / 2 / 25.4) < 1e-9);
  // Default (no base) → 28mm round.
  assert.ok(Math.abs(R.unitBaseRadius({}) - 28 / 2 / 25.4) < 1e-9);
  // Oval uses max axis (conservative envelope, see CLAUDE.md).
  const oval = R.unitBaseRadius({ base: { w: 60, h: 35 } });
  assert.ok(Math.abs(oval - 60 / 2 / 25.4) < 1e-9);
});

test('edgeDist: clamps to 0 when bases overlap, otherwise base-edge separation', () => {
  const a = { x: 0, y: 0, base: { d: 32 } };
  const b = { x: 0, y: 0, base: { d: 32 } };
  assert.equal(R.edgeDist(a, b), 0);
  b.x = 10; // 10" centre-to-centre
  const expected = 10 - 2 * (32 / 2 / 25.4);
  assert.ok(Math.abs(R.edgeDist(a, b) - expected) < 1e-9);
});

// ── Walls / LoS ──────────────────────────────────────────────────────────
test('losBlockedByWalls: true when path crosses a wall, false when clear', () => {
  const map = { walls: [{ x1: 5, y1: 0, x2: 5, y2: 10 }] };
  assert.equal(R.losBlockedByWalls(map, null, 0, 5, 10, 5), true);
  assert.equal(R.losBlockedByWalls(map, null, 0, 5, 4, 5), false);
});

test('effectiveWalls drops segments whose pieceIndex is currently open', () => {
  const map = {
    walls: [
      { x1: 0, y1: 0, x2: 4, y2: 0, pieceIndex: 0 },  // openable
      { x1: 4, y1: 0, x2: 8, y2: 0, pieceIndex: null }, // permanent
    ],
  };
  const open = new Set([0]);
  const eff = R.effectiveWalls(map, open);
  assert.equal(eff.length, 1);
  assert.equal(eff[0].pieceIndex, null);
});

test('moveBlockedByWalls: a base whose footprint touches a wall is blocked', () => {
  const map = { walls: [{ x1: 5, y1: 0, x2: 5, y2: 10 }] };
  const r = 0.6; // ~30mm round base
  // Endpoint at (4, 5), within r of the wall at x=5 → blocked.
  assert.equal(R.moveBlockedByWalls(map, null, 0, 5, 4.5, 5, r), true);
  // Endpoint at (3, 5), 2" from the wall → clear.
  assert.equal(R.moveBlockedByWalls(map, null, 0, 5, 3, 5, r), false);
});

// ── Cover ────────────────────────────────────────────────────────────────
test('lightCoverIntervening: light terrain >2" from shooter and on target side gives cover', () => {
  // Shooter (0,5) → target (20,5). Terrain at (16,5) is on the target side.
  const map = { terrain: [{ type: 'square', x: 16, y: 5, size: 2.0 }], walls: [] };
  assert.equal(R.lightCoverIntervening(map, 0, 5, 20, 5), true);
  // Shooter 1.5" from terrain — fails COVER_FAR_THRESHOLD (>2") even though
  // terrain still sits between shooter and target.
  assert.equal(R.lightCoverIntervening(map, 14.5, 5, 20, 5), false);
  // Terrain on shooter's side (closer to shooter than to target) — no cover.
  const sideMap = { terrain: [{ type: 'square', x: 4, y: 5, size: 2.0 }], walls: [] };
  assert.equal(R.lightCoverIntervening(sideMap, 0, 5, 20, 5), false);
});

test('shootEnv combines wall-LoS and light cover into a single reading', () => {
  // Terrain at (16,5) sits on the target side; wall at x=12 blocks LoS.
  const terrain = [{ type: 'square', x: 16, y: 5, size: 2.0 }];
  const walls = [{ x1: 12, y1: 0, x2: 12, y2: 10 }];
  let env = R.shootEnv({ walls, terrain }, null, { x: 0, y: 5 }, { x: 20, y: 5 });
  assert.deepEqual(env, { visible: false, inCover: false });
  // Without the wall — visible AND in cover.
  env = R.shootEnv({ walls: [], terrain }, null, { x: 0, y: 5 }, { x: 20, y: 5 });
  assert.deepEqual(env, { visible: true, inCover: true });
});

// ── Engagement / control range ───────────────────────────────────────────
test('controlRangeOf: only living deployed enemies inside engagement range count', () => {
  const r = 28 / 2 / 25.4; // default 28mm radius
  const me = { team: 'A', x: 0, y: 0, alive: true, deployed: true, base: { d: 28 } };
  const enemy = { team: 'B', x: r * 2 + 0.5, y: 0, alive: true, deployed: true, base: { d: 28 } };
  const dead  = { team: 'B', x: 1, y: 0, alive: false, deployed: true, base: { d: 28 } };
  const undeployed = { team: 'B', x: 1, y: 0, alive: true, deployed: false, base: { d: 28 } };
  const friendly   = { team: 'A', x: 1, y: 0, alive: true, deployed: true, base: { d: 28 } };
  const out = R.controlRangeOf(me, [enemy, dead, undeployed, friendly]);
  assert.equal(out.length, 1);
  assert.equal(out[0], enemy);
});

test('inEnemyControlRangeAt: tests against a hypothetical position', () => {
  const me = { team: 'A', x: 0, y: 0, alive: true, deployed: true, base: { d: 28 } };
  const enemy = { team: 'B', x: 5, y: 0, alive: true, deployed: true, base: { d: 28 } };
  // From (0,0) we're 5" away → not engaged.
  assert.equal(R.inEnemyControlRange(me, [enemy]), false);
  // Hypothetical step right next to the enemy.
  assert.equal(R.inEnemyControlRangeAt(me, [enemy], 4, 0), true);
});

// ── Action validation ────────────────────────────────────────────────────
function baseActivation(over = {}) {
  return {
    order: 'engage', ap: 2,
    hasReposition: false, hasDashed: false,
    hasCharged: false, hasFallenBack: false,
    ...over,
  };
}

test('validate.reposition: passes when fresh, fails after charge / fall back / re-use', () => {
  const u = {};
  assert.equal(R.validate.reposition(u, baseActivation()), null);
  assert.match(R.validate.reposition(u, baseActivation({ hasCharged: true })), /Charge/);
  assert.match(R.validate.reposition(u, baseActivation({ hasFallenBack: true })), /Fall Back/);
  assert.match(R.validate.reposition(u, baseActivation({ hasReposition: true })), /Already Repositioned/);
  assert.match(R.validate.reposition(u, baseActivation({ ap: 0 })), /AP/);
});

test('validate.dash: AP-gated and forbidden after charge', () => {
  const u = {};
  assert.equal(R.validate.dash(u, baseActivation()), null);
  assert.match(R.validate.dash(u, baseActivation({ hasCharged: true })), /Charge/);
  assert.match(R.validate.dash(u, baseActivation({ hasDashed: true })), /Already Dashed/);
});

test('validate.charge: requires Engage order and no engaged enemy', () => {
  const u = { team: 'A', x: 0, y: 0, base: { d: 28 } };
  const enemy = { team: 'B', x: 1, y: 0, alive: true, deployed: true, base: { d: 28 } };
  assert.match(R.validate.charge(u, baseActivation({ order: 'conceal' }), []), /Engage/);
  assert.match(R.validate.charge(u, baseActivation(), [enemy]), /control range/);
  assert.equal(R.validate.charge(u, baseActivation(), []), null);
});

test('validate.fallBack: requires being engaged and 2 AP', () => {
  const u = { team: 'A', x: 0, y: 0, alive: true, deployed: true, base: { d: 28 } };
  const enemy = { team: 'B', x: 1, y: 0, alive: true, deployed: true, base: { d: 28 } };
  assert.match(R.validate.fallBack(u, baseActivation(), []), /control range/);
  assert.match(R.validate.fallBack(u, baseActivation({ ap: 1 }), [enemy]), /AP/);
  assert.equal(R.validate.fallBack(u, baseActivation(), [enemy]), null);
});

test('validate.shoot: needs Engage, ranged weapon, and free of enemy control range', () => {
  const ranged = { weapons: [{ is_melee: false }], team: 'A', x: 0, y: 0, base: { d: 28 } };
  const melee  = { weapons: [{ is_melee: true }],  team: 'A', x: 0, y: 0, base: { d: 28 } };
  const adjacentEnemy = { team: 'B', x: 1, y: 0, alive: true, deployed: true, base: { d: 28 } };
  assert.match(R.validate.shoot(ranged, baseActivation({ order: 'conceal' }), []), /Engage/);
  assert.match(R.validate.shoot(melee, baseActivation(), []), /No ranged/);
  assert.match(R.validate.shoot(ranged, baseActivation(), [adjacentEnemy]), /control range/);
  assert.equal(R.validate.shoot(ranged, baseActivation(), []), null);
});

test('validate.fight: requires melee weapon and adjacent enemy', () => {
  const melee = { weapons: [{ is_melee: true }], team: 'A', x: 0, y: 0, base: { d: 28 } };
  const enemy = { team: 'B', x: 1, y: 0, alive: true, deployed: true, base: { d: 28 } };
  // No enemy nearby → control range failure first.
  assert.match(R.validate.fight(melee, baseActivation(), []), /control range/);
  // Engaged but unit has no melee weapon → "No melee" surfaces.
  const noMelee = { weapons: [], team: 'A', x: 0, y: 0, base: { d: 28 } };
  assert.match(R.validate.fight(noMelee, baseActivation(), [enemy]), /No melee/);
  assert.equal(R.validate.fight(melee, baseActivation(), [enemy]), null);
});

test('breachAPCost: 1 for grenadiers / breachers / miners, 2 otherwise', () => {
  assert.equal(R.breachAPCost({ name: 'Some Trooper' }), 2);
  assert.equal(R.breachAPCost({ name: 'Veteran Grenadier' }), 1);
  assert.equal(R.breachAPCost({ name: 'Breacher Squad' }), 1);
  assert.equal(R.breachAPCost({ _displayName: 'Tomb Miner' }), 1);
});

test('isInjured: true once HP drops below ceil(maxHp/2)', () => {
  assert.equal(R.isInjured({ alive: true, hp: 5, maxHp: 10 }), false); // 5 == ceil(10/2) → above wound threshold
  assert.equal(R.isInjured({ alive: true, hp: 4, maxHp: 10 }), true);
  assert.equal(R.isInjured({ alive: false, hp: 0, maxHp: 10 }), false);
});

test('parseMoveStat handles strings with units and bare numbers', () => {
  assert.equal(R.parseMoveStat('6"'), 6);
  assert.equal(R.parseMoveStat('5'), 5);
  assert.equal(R.parseMoveStat(undefined), 6);
});

// ── resolveShootDamage end-to-end ────────────────────────────────────────
test('resolveShootDamage: brutal weapon ignores normal saves', () => {
  const weapon = { normal_dmg: 3, crit_dmg: 4, _parsedRules: R.parseWeaponRules(['Brutal']) };
  const out = R.resolveShootDamage({
    weapon, atkN: 2, atkC: 0, defN: 5, defC: 0, atkF: 0,
  });
  assert.equal(out.dmg, 6);
});

test('resolveShootDamage: Devastating X adds X mortal per crit before saves', () => {
  const weapon = { normal_dmg: 3, crit_dmg: 4, _parsedRules: R.parseWeaponRules([]) };
  const out = R.resolveShootDamage({
    weapon, atkN: 0, atkC: 1, defN: 0, defC: 1,
    devastating: 2,
  });
  // 1 crit-vs-crit cancels the rolled crit damage; devastating 2 still applies.
  assert.equal(out.dmg, 2);
});
