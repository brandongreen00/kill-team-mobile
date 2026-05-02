// Loads the browser-only modules into Node by faking the small bits of the
// browser environment they touch. The modules attach themselves to `window`
// (or `globalThis`); after this file is required the suites can read
// `window.KT`, `window.KT_RULES`, `window.FACTIONS` directly.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

// Minimal localStorage shim. A few maps-data.js helpers (loadCustomMaps /
// saveCustomMap / deleteCustomMap) read it; tests that exercise persistence
// can call resetStorage() between cases.
function makeMemoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(String(k), String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => { data.clear(); },
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
    _data: data,
  };
}

function setup() {
  if (globalThis.__KT_TEST_LOADED) return globalThis.__KT_TEST_LOADED;

  // rules.js does `(function (root) { ... })(window)` — so `window` must exist
  // and be writable. We collapse it onto globalThis so `window === globalThis`,
  // which is also what the modules expect when they attach `window.KT` etc.
  globalThis.window = globalThis;
  globalThis.localStorage = makeMemoryStorage();
  // Some pieces of maps-data reference sessionStorage indirectly via tests; we
  // include it for parity with the browser.
  globalThis.sessionStorage = makeMemoryStorage();

  function loadScript(rel) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInThisContext(src, { filename: rel });
  }

  loadScript('rules.js');
  loadScript('maps-data.js');
  loadScript('factions.js');

  globalThis.__KT_TEST_LOADED = {
    KT: globalThis.KT,
    KT_RULES: globalThis.KT_RULES,
    FACTIONS: globalThis.FACTIONS,
    resetStorage() {
      globalThis.localStorage.clear();
      globalThis.sessionStorage.clear();
    },
    // Replace Math.random with a deterministic LCG so dice-rolling tests are
    // reproducible. Returns a `restore` function.
    seedRandom(seed) {
      const orig = Math.random;
      let s = (seed >>> 0) || 1;
      Math.random = () => {
        // xorshift32 → [0, 1)
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return (s >>> 0) / 0x100000000;
      };
      return () => { Math.random = orig; };
    },
    // Fixed-sequence RNG for very-targeted dice tests.
    sequenceRandom(values) {
      const orig = Math.random;
      let i = 0;
      Math.random = () => {
        const v = values[i % values.length];
        i++;
        // values are 1..6 D6 results; convert to a Math.random() value that
        // floors to (v - 1).
        return (v - 1 + 0.5) / 6;
      };
      return () => { Math.random = orig; };
    },
  };
  return globalThis.__KT_TEST_LOADED;
}

module.exports = { setup };
