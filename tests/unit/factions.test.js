// Sanity checks for factions.js. The data is vendored from upstream and
// hand-edits are discouraged, so these tests stay shallow: shape & invariants
// only — not specific stat lines.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./load');

const { FACTIONS, KT_RULES } = setup();

test('FACTIONS is a non-empty array of distinct ids', () => {
  assert.ok(Array.isArray(FACTIONS));
  assert.ok(FACTIONS.length >= 10);
  const ids = FACTIONS.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('Every faction declares operatives with weapons and stats', () => {
  for (const f of FACTIONS) {
    assert.ok(typeof f.id === 'string' && f.id.length > 0, `${f.id}: id`);
    assert.ok(typeof f.name === 'string' && f.name.length > 0, `${f.id}: name`);
    assert.ok(Array.isArray(f.operatives), `${f.id}: operatives`);
    assert.ok(f.operatives.length >= 1, `${f.id}: at least one operative`);
    for (const op of f.operatives) {
      assert.ok(typeof op.id === 'string', `${f.id}: operative id`);
      assert.ok(Array.isArray(op.weapons), `${f.id}/${op.id}: weapons`);
      // Move stat must parse to a number we can use in rules.js.
      const m = KT_RULES.parseMoveStat(op.M);
      assert.ok(Number.isFinite(m) && m > 0, `${f.id}/${op.id}: bad M`);
    }
  }
});

test('Every operative weapon parses to a known set of rules', () => {
  let unknown = 0;
  for (const f of FACTIONS) {
    for (const op of f.operatives) {
      for (const w of (op.weapons || [])) {
        const parsed = KT_RULES.parseWeaponRules(w.rules || []);
        for (const r of parsed) if (r.name === '_unknown') unknown++;
      }
    }
  }
  // We don't assert zero — the parser intentionally bins keywords it doesn't
  // model — but a wildly large number would mean upstream introduced new
  // keywords we should consider. Treat anything beyond ~50% of weapon rules
  // total as a regression worth surfacing.
  const total = FACTIONS.reduce(
    (n, f) => n + f.operatives.reduce(
      (m, o) => m + (o.weapons || []).reduce((k, w) => k + (w.rules || []).length, 0), 0), 0);
  assert.ok(unknown < total / 2, `Too many unrecognised rules: ${unknown}/${total}`);
});

test('Every operative parses keywords without throwing', () => {
  for (const f of FACTIONS) {
    for (const op of f.operatives) {
      // KT_RULES.isGrenadier shouldn't throw on any operative shape.
      KT_RULES.isGrenadier(op);
    }
  }
});
